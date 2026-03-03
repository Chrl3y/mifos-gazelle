import axios, { AxiosInstance, AxiosResponse } from "axios";
import { FineractConfig } from "../types/index.js";

export class FineractClient {
  private http: AxiosInstance;
  private config: FineractConfig;

  constructor(config: FineractConfig) {
    this.config = config;
    const token = Buffer.from(`${config.username}:${config.password}`).toString("base64");
    this.http = axios.create({
      baseURL: config.baseUrl,
      headers: {
        Authorization: `Basic ${token}`,
        "Fineract-Platform-TenantId": config.tenantId,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      timeout: 30000,
    });
  }

  async get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    const res: AxiosResponse<T> = await this.http.get(path, { params });
    return res.data;
  }

  async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res: AxiosResponse<T> = await this.http.post(path, body);
    return res.data;
  }

  async put<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res: AxiosResponse<T> = await this.http.put(path, body);
    return res.data;
  }

  /** Fetch all pages of a paginated Fineract list endpoint */
  async getAllPages<T>(
    path: string,
    params: Record<string, unknown> = {}
  ): Promise<T[]> {
    const results: T[] = [];
    let offset = 0;
    const limit = 200;
    while (true) {
      const page = await this.get<{ pageItems: T[]; totalFilteredRecords: number }>(
        path,
        { ...params, limit, offset }
      );
      results.push(...(page.pageItems ?? []));
      if (results.length >= page.totalFilteredRecords) break;
      offset += limit;
    }
    return results;
  }

  getBaseUrl(): string {
    return this.config.baseUrl;
  }
}

export function createClientFromEnv(): FineractClient {
  const config: FineractConfig = {
    baseUrl: process.env.FINERACT_BASE_URL ?? "http://localhost:8080/fineract-provider/api/v1",
    tenantId: process.env.FINERACT_TENANT_ID ?? "default",
    username: process.env.FINERACT_USERNAME ?? "mifos",
    password: process.env.FINERACT_PASSWORD ?? "password",
  };
  return new FineractClient(config);
}
