# Fix Blueprint: ISS-HUB-001 to ISS-HUB-006 – HUB Payment Processing Fixes

**Priority:** CRITICAL / HIGH
**System:** Helaplus HUB – PHP Layer
**Status:** ESCALATED / NEW

---

## ISS-HUB-001: Undefined $loan Variable in PaymentsController.php:977

### Root Cause
The `processLoan()` method references `$loan` before it is guaranteed to be assigned. If the loan lookup returns null/false, `$loan` is undefined when accessed at line 977.

### Fix

```php
// PaymentsController.php – replayUploadedPayments() or processLoan()

// BEFORE (buggy):
public function processLoan($paymentData) {
    if ($paymentData['phone']) {
        $client = Client::findByPhone($paymentData['phone']);
        if ($client) {
            $loan = Loan::findActiveByClient($client->id);
        }
        // $loan may be undefined if no active loan found!
    }

    // Line 977: Undefined variable: $loan
    $result = $this->postRepayment($loan, $paymentData['amount']); // ❌
}

// AFTER (fixed):
public function processLoan($paymentData) {
    $loan = null;  // ✅ Initialize before conditional

    if ($paymentData['phone']) {
        $client = Client::findByPhone($paymentData['phone']);
        if ($client) {
            $loan = Loan::findActiveByClient($client->id);
        }
    }

    // Guard before use
    if (!$loan) {
        Log::warning('processLoan: No active loan found for payment', [
            'reference' => $paymentData['reference'] ?? 'unknown',
            'phone' => $paymentData['phone'] ?? 'unknown',
            'amount' => $paymentData['amount'],
        ]);
        return ['status' => 'unmatched', 'reason' => 'No active loan found'];
    }

    $result = $this->postRepayment($loan, $paymentData['amount']); // ✅
    return $result;
}
```

---

## ISS-HUB-002: Airtel CSV Parser – Withdraw Transaction Not Filtered

### Fix

```php
// AirtelCsvParser.php – parse() method

// BEFORE (missing filter):
public function parse(array $rows): array {
    $transactions = [];
    foreach ($rows as $row) {
        $transactions[] = $this->mapRow($row);  // Includes withdrawals ❌
    }
    return $transactions;
}

// AFTER (with filter matching MTN parser):
// Transaction types to EXCLUDE (Airtel-specific values – verify against actual CSV)
private const EXCLUDED_TYPES = ['WITHDRAW', 'WITHDRAWAL', 'C2B_DEBIT', 'REVERSAL'];

public function parse(array $rows): array {
    $transactions = [];
    foreach ($rows as $row) {
        // Skip withdraw/reversal transactions (matching MTN parser behaviour)
        $txType = strtoupper(trim($row['Transaction Type'] ?? $row['transaction_type'] ?? ''));
        if (in_array($txType, self::EXCLUDED_TYPES, true)) {
            continue;
        }
        $transactions[] = $this->mapRow($row);
    }
    return $transactions;
}
```

**Note:** Verify exact column name and value for Airtel transaction type by inspecting a sample Airtel CSV file.

---

## ISS-HUB-003: Airtel Date Format Parsing Error (Future Dates)

### Root Cause
Airtel CSV likely uses `DD/MM/YYYY` format but parser interprets as `MM/DD/YYYY`, causing month/day swap (e.g., November 2026 instead of March 2026 for date 03/11/2026).

### Fix

```php
// AirtelCsvParser.php – parseDate() method

// BEFORE (wrong format assumption):
private function parseDate(string $dateStr): \DateTime {
    return \DateTime::createFromFormat('m/d/Y', $dateStr);  // MM/DD/YYYY ❌
}

// AFTER (correct Airtel format):
private function parseDate(string $dateStr): \DateTime {
    // Airtel Uganda uses DD/MM/YYYY format
    $date = \DateTime::createFromFormat('d/m/Y', $dateStr);

    if (!$date) {
        // Try alternative formats
        $formats = ['d/m/Y H:i:s', 'd-m-Y', 'Y-m-d', 'd/m/Y H:i'];
        foreach ($formats as $format) {
            $date = \DateTime::createFromFormat($format, $dateStr);
            if ($date) break;
        }
    }

    if (!$date) {
        throw new \InvalidArgumentException("Cannot parse Airtel date: {$dateStr}");
    }

    // Sanity check: reject future dates > 1 day from today
    $tomorrow = new \DateTime('+1 day');
    if ($date > $tomorrow) {
        throw new \InvalidArgumentException(
            "Airtel date {$dateStr} parsed as future date {$date->format('Y-m-d')} – likely format error"
        );
    }

    return $date;
}
```

---

## ISS-HUB-004: YO! Uganda CSV Parser Not Implemented

### YO! CSV Format Analysis
YO! Uganda Mobile Money statements typically have this structure (verify against actual file):

```csv
Transaction ID,Date,Time,Sender,Receiver Phone,Amount,Fee,Status,Reference
YO1234567,2026-03-03,14:30:00,+256701234567,+256789012345,150000,0,SUCCESSFUL,LOAN-REPAY-001
```

### Implementation

```php
// Create new file: YoUgandaCsvParser.php

class YoUgandaCsvParser implements CsvParserInterface {

    // YO! column mapping (adjust based on actual CSV headers)
    private const COLUMN_MAP = [
        'reference'   => 'Transaction ID',
        'date'        => 'Date',
        'time'        => 'Time',
        'phone'       => 'Sender',
        'amount'      => 'Amount',
        'status'      => 'Status',
        'description' => 'Reference',
    ];

    private const EXCLUDED_STATUSES = ['FAILED', 'REVERSED', 'CANCELLED'];
    private const EXCLUDED_TYPES = ['WITHDRAWAL', 'DEBIT'];

    public function parse(array $rows): array {
        $transactions = [];

        foreach ($rows as $index => $row) {
            try {
                // Skip failed/reversed transactions
                $status = strtoupper(trim($row[self::COLUMN_MAP['status']] ?? ''));
                if (in_array($status, self::EXCLUDED_STATUSES, true)) {
                    continue;
                }

                $transactions[] = [
                    'reference'   => $row[self::COLUMN_MAP['reference']] ?? "YO-ROW-{$index}",
                    'amount'      => (float)str_replace(',', '', $row[self::COLUMN_MAP['amount']] ?? 0),
                    'phone'       => $this->normalizePhone($row[self::COLUMN_MAP['phone']] ?? ''),
                    'date'        => $this->parseDate(
                        $row[self::COLUMN_MAP['date']] . ' ' . ($row[self::COLUMN_MAP['time']] ?? '00:00:00')
                    ),
                    'provider'    => 'YO',
                    'status'      => $status,
                    'description' => $row[self::COLUMN_MAP['description']] ?? '',
                ];
            } catch (\Exception $e) {
                Log::warning("YO! parser: skipped row {$index}: " . $e->getMessage());
            }
        }

        return $transactions;
    }

    private function parseDate(string $dateTimeStr): \DateTime {
        $date = \DateTime::createFromFormat('Y-m-d H:i:s', $dateTimeStr)
              ?? \DateTime::createFromFormat('Y-m-d H:i', $dateTimeStr)
              ?? \DateTime::createFromFormat('d/m/Y H:i:s', $dateTimeStr);

        if (!$date) {
            throw new \InvalidArgumentException("Cannot parse YO! date: {$dateTimeStr}");
        }
        return $date;
    }

    private function normalizePhone(string $phone): string {
        $phone = preg_replace('/\D/', '', $phone);
        if (str_starts_with($phone, '256')) return '+' . $phone;
        if (str_starts_with($phone, '0')) return '+256' . substr($phone, 1);
        return '+256' . $phone;
    }
}
```

**Register parser in ParserFactory:**
```php
// CsvParserFactory.php
case 'yo':
case 'yo_uganda':
    return new YoUgandaCsvParser();
```

---

## ISS-HUB-006: USSD Down Payment Misrouting

### Fix – Payment Routing Logic

```php
// PaymentsController.php – route() or processIncomingPayment()

public function routePayment(array $paymentData): array {
    $phone = $this->normalizePhone($paymentData['phone']);
    $amount = $paymentData['amount'];
    $reference = $paymentData['reference'];

    // NEW: Check payment intent discriminator
    $intent = $paymentData['payment_intent'] ?? null;

    // Find client by phone
    $client = Client::findByPhone($phone);
    if (!$client) {
        return ['status' => 'unmatched', 'reason' => 'Client not found'];
    }

    // Priority routing logic:
    // 1. If intent == 'down_payment' OR loan is APPROVED (not yet active) → down payment
    // 2. If intent == 'repayment' OR loan is ACTIVE → repayment

    $approvedLoan = Loan::findApprovedByClient($client->id);
    $activeLoan   = Loan::findActiveByClient($client->id);

    if ($intent === 'down_payment' || ($approvedLoan && !$activeLoan)) {
        // Route as down payment
        if (!$approvedLoan) {
            return ['status' => 'error', 'reason' => 'No approved loan found for down payment'];
        }
        return $this->postDownPayment($approvedLoan, $amount, $reference);
    }

    if ($activeLoan) {
        return $this->postRepayment($activeLoan, $amount, $reference);
    }

    return ['status' => 'unmatched', 'reason' => 'No eligible loan found'];
}
```

---

## Testing Checklist

- [ ] ISS-HUB-001: All 3 payment buttons work without PHP error
- [ ] ISS-HUB-002: Airtel CSV with withdraw rows uploads cleanly
- [ ] ISS-HUB-003: Airtel CSV dates parse as current period (not future)
- [ ] ISS-HUB-004: YO! Uganda CSV uploads and matches payments
- [ ] ISS-HUB-006: USSD down payment applies to APPROVED loan, not active
- [ ] All parsers: amounts correctly parsed (no comma stripping errors)
- [ ] All parsers: phone numbers normalized to +256 format
