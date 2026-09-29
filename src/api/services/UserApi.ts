/** User directory service. */

import { API_ROUTES } from '../../constants/ApiConstants';
import type { ApiResponse, AuthenticatedUser } from '../../types/ApiModels';
import { BaseApiService } from './BaseApiService';

export class UserApi extends BaseApiService {
  public async list(): Promise<ApiResponse<AuthenticatedUser[]>> {
    return this.client.get<AuthenticatedUser[]>(API_ROUTES.users.list);
  }

  /** Finds a user by email, or returns undefined when absent. */
  public async findByEmail(email: string): Promise<AuthenticatedUser | undefined> {
    const response = await this.list();
    return response.data?.find((user) => user.email.toLowerCase() === email.toLowerCase());
  }

  public async departments(): Promise<ApiResponse<string[]>> {
    return this.client.get<string[]>(API_ROUTES.departments);
  }
}
