import { APP_INITIALIZER, ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideRouter } from '@angular/router';

import { routes } from './app.routes';
import { RoutineService } from './services/routine.service';
import { AuthService } from './services/auth.service';
import { environment } from '../environments/environment';
import { authInterceptor } from './interceptors/auth.interceptor';
import { unauthorizedInterceptor } from './interceptors/unauthorized.interceptor';

export function appBootstrap(auth: AuthService, routine: RoutineService) {
  return async () => {
    auth.restoreSession();
    if (!environment.apiBaseUrl) {
      await routine.loadInitial();
    } else if (auth.isLoggedIn()) {
      await routine.loadInitial();
    } else {
      routine.resetToEmpty();
    }
  };
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideHttpClient(withInterceptors([authInterceptor, unauthorizedInterceptor])),
    {
      provide: APP_INITIALIZER,
      useFactory: appBootstrap,
      deps: [AuthService, RoutineService],
      multi: true,
    },
  ],
};
