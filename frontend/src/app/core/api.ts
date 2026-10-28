import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import {
  Block,
  Conflict,
  FieldError,
  GenerateIn,
  Generated,
  ScheduleLimits,
  Service,
  ServiceIn,
  Track,
  VehicleTimeline,
} from './models';

/** Calls to the backend. nginx forwards /api to it, so there is no CORS. */
@Injectable({ providedIn: 'root' })
export class Api {
  private readonly http = inject(HttpClient);

  track(): Promise<Track> {
    return firstValueFrom(this.http.get<Track>('/api/track'));
  }

  async vehicles(): Promise<string[]> {
    const vehicles = await firstValueFrom(this.http.get<{ id: string }[]>('/api/vehicles'));
    return vehicles.map((v) => v.id);
  }

  blocks(): Promise<Block[]> {
    return firstValueFrom(this.http.get<Block[]>('/api/blocks'));
  }

  saveBlocks(blocks: Block[]): Promise<Block[]> {
    return firstValueFrom(this.http.put<Block[]>('/api/blocks', blocks));
  }

  services(): Promise<Service[]> {
    return firstValueFrom(this.http.get<Service[]>('/api/services'));
  }

  createService(body: ServiceIn): Promise<Service> {
    return firstValueFrom(this.http.post<Service>('/api/services', body));
  }

  replaceService(id: number, body: ServiceIn): Promise<Service> {
    return firstValueFrom(this.http.put<Service>(`/api/services/${id}`, body));
  }

  /** All or nothing: if any id is missing, nothing is deleted (404). */
  deleteServices(ids: number[]): Promise<void> {
    return firstValueFrom(this.http.post<void>('/api/services/delete', { ids }));
  }

  conflicts(): Promise<Conflict[]> {
    return firstValueFrom(this.http.get<Conflict[]>('/api/conflicts'));
  }

  timeline(): Promise<VehicleTimeline[]> {
    return firstValueFrom(this.http.get<VehicleTimeline[]>('/api/timeline'));
  }

  scheduleLimits(start: string, end: string): Promise<ScheduleLimits> {
    const params = new HttpParams().set('start', start).set('end', end);
    return firstValueFrom(this.http.get<ScheduleLimits>('/api/schedule/limits', { params }));
  }

  generateSchedule(body: GenerateIn): Promise<Generated> {
    return firstValueFrom(this.http.post<Generated>('/api/schedule/generate', body));
  }
}

/** The field errors of a 422, or null for any other failure. */
export function fieldErrors(error: unknown): FieldError[] | null {
  if (error instanceof HttpErrorResponse && error.status === 422 && Array.isArray(error.error?.detail)) {
    return error.error.detail as FieldError[];
  }
  return null;
}

/** A short message for failures the user can't fix in a form. */
export function failureMessage(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    if (error.status === 0) return 'Cannot reach the server. Is the backend running?';
    if (typeof error.error?.detail === 'string') return error.error.detail;
    return `Request failed (${error.status})`;
  }
  return 'Something went wrong';
}
