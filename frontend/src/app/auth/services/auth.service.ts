import { Injectable } from '@angular/core';
import { HttpBackend, HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Router } from '@angular/router';
import { BehaviorSubject, Observable, tap } from 'rxjs';

export interface LoginResponse {
  access_token: string;
}

export interface User {
  userId: number;
  email: string;
  role: string;
}

interface JwtPayload {
  sub?: number;
  email?: string;
  role?: string;
  exp?: number;
}

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private readonly TOKEN_KEY = 'auth_token';
  private readonly API_URL = '/api/auth';

  private currentUserSubject = new BehaviorSubject<User | null>(null);
  public currentUser$ = this.currentUserSubject.asObservable();
  private http: HttpClient;

  constructor(
    httpBackend: HttpBackend,
    private router: Router
  ) {
    this.http = new HttpClient(httpBackend);

    if (this.isAuthenticated()) {
      this.seedCurrentUserFromToken();
      this.loadUserProfile();
    } else if (this.getToken()) {
      this.clearSession();
    }
  }

  login(email: string, password: string): Observable<LoginResponse> {
    return this.http.post<LoginResponse>(`${this.API_URL}/login`, { email, password })
      .pipe(
        tap(response => {
          this.setToken(response.access_token);
          this.seedCurrentUserFromToken();
          this.loadUserProfile();
        })
      );
  }

  logout(redirect = true): void {
    this.clearSession();

    if (redirect) {
      this.router.navigate(['/login']);
    }
  }

  getToken(): string | null {
    return localStorage.getItem(this.TOKEN_KEY);
  }

  private setToken(token: string): void {
    localStorage.setItem(this.TOKEN_KEY, token);
  }

  isAuthenticated(): boolean {
    const payload = this.decodeTokenPayload();
    if (!payload?.exp) {
      return false;
    }

    return Date.now() < payload.exp * 1000;
  }

  private loadUserProfile(): void {
    const token = this.getToken();
    const headers = token ? new HttpHeaders({ Authorization: `Bearer ${token}` }) : undefined;

    this.http.get<User>(`${this.API_URL}/profile`, { headers })
      .subscribe({
        next: (user) => this.currentUserSubject.next(user),
        error: (error: unknown) => {
          if (error instanceof HttpErrorResponse && [401, 403].includes(error.status)) {
            this.logout();
          }
        }
      });
  }

  getCurrentUser(): User | null {
    return this.currentUserSubject.value;
  }

  private clearSession(): void {
    localStorage.removeItem(this.TOKEN_KEY);
    this.currentUserSubject.next(null);
  }

  private seedCurrentUserFromToken(): void {
    const payload = this.decodeTokenPayload();

    if (!payload?.sub || !payload.email || !payload.role) {
      return;
    }

    this.currentUserSubject.next({
      userId: payload.sub,
      email: payload.email,
      role: payload.role
    });
  }

  private decodeTokenPayload(): JwtPayload | null {
    const token = this.getToken();
    if (!token) {
      return null;
    }

    const [, payload] = token.split('.');
    if (!payload) {
      return null;
    }

    try {
      const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, '=');
      return JSON.parse(atob(padded)) as JwtPayload;
    } catch {
      return null;
    }
  }
}
