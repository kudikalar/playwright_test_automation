/** Authentication domain service: sign-in, identity and sign-out. */

import { API_ROUTES } from '../../constants/ApiConstants';
import type {
  ApiResponse,
  AuthenticatedUser,
  LoginRequest,
  LoginResponse,
} from '../../types/ApiModels';
import type { UserRole } from '../../types/Environment';
import { getEnvironment } from '../../../config/environment.config';
import { ApiRequestError } from '../../utils/FrameworkError';
import { BaseApiService } from './BaseApiService';

export class AuthApi extends BaseApiService {
  /** Raw login call; returns the envelope so negative tests can assert failures. */
  public async login(credentials: LoginRequest): Promise<ApiResponse<LoginResponse>> {
    return this.client.post<LoginResponse>(API_ROUTES.auth.login, {
      body: credentials,
      skipAuth: true,
    });
  }

  /**
   * Signs in as a configured role and returns the token, resolving the secret from the
   * environment. Throws with context when the credentials are rejected.
   */
  public async loginAs(role: UserRole): Promise<LoginResponse> {
    const environment = getEnvironment();
    const credentials = environment.credentialsFor(role);
    const response = await this.login({
      username: credentials.username,
      password: credentials.password,
    });

    if (!response.ok || !response.data) {
      throw new ApiRequestError('API login failed', {
        operation: 'loginAs',
        target: role,
        environment: environment.name,
        expected: 'HTTP 200 with a token',
        actual: `HTTP ${response.status} ${response.error?.code ?? ''}`.trim(),
      });
    }
    this.log.info('API session established', { role, userId: response.data.user.id });
    return response.data;
  }

  /** Signs in and binds the token to the shared client, for subsequent service calls. */
  public async authenticateClientAs(role: UserRole): Promise<LoginResponse> {
    const session = await this.loginAs(role);
    this.client.setAuthToken(session.token);
    return session;
  }

  public async me(): Promise<ApiResponse<AuthenticatedUser>> {
    return this.client.get<AuthenticatedUser>(API_ROUTES.auth.me);
  }

  public async logout(): Promise<ApiResponse<{ loggedOut: boolean }>> {
    const response = await this.client.post<{ loggedOut: boolean }>(API_ROUTES.auth.logout);
    this.client.clearAuthToken();
    return response;
  }

  /** Health probe used by global setup to fail fast when the environment is down. */
  public async health(): Promise<ApiResponse<{ status: string }>> {
    return this.client.get<{ status: string }>(API_ROUTES.health, { skipAuth: true });
  }
}
