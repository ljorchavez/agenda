import { useQuery } from '@tanstack/react-query';
import type { CustomerWithStats, LocationDto, PlanDto, ProfessionalDto, ServiceDto, SpaceDto } from '@agenda/shared';
import { api } from './api';

export const useServices = () =>
  useQuery({ queryKey: ['services'], queryFn: () => api<ServiceDto[]>('/services') });

/** `forBooking` lets a colaborador find any existing customer by name/phone when booking. */
export const useCustomers = (q = '', sort = 'name', forBooking = false) =>
  useQuery({
    queryKey: ['customers', q, sort, forBooking],
    queryFn: () =>
      api<{ items: CustomerWithStats[]; total: number }>(
        `/customers?limit=200&sort=${sort}${q ? `&q=${encodeURIComponent(q)}` : ''}${forBooking ? '&for=booking' : ''}`,
      ),
  });

export const useProfessionals = (enabled = true) =>
  useQuery({ queryKey: ['professionals'], queryFn: () => api<ProfessionalDto[]>('/professionals'), enabled });

export const useSpaces = (enabled = true) =>
  useQuery({ queryKey: ['spaces'], queryFn: () => api<SpaceDto[]>('/spaces'), enabled });

export const useLocations = () =>
  useQuery({ queryKey: ['locations'], queryFn: () => api<{ locations: LocationDto[]; plan: PlanDto }>('/locations') });

/**
 * Locations this login works with: every active one, or just its own when limited to a location.
 * `multi` is true when there is a choice to show (more than one location).
 */
export function useMyLocations(limitedTo: string | null) {
  const q = useLocations();
  const all = (q.data?.locations ?? []).filter((l) => l.active);
  const list = limitedTo ? all.filter((l) => l.id === limitedTo) : all;
  const byId = new Map((q.data?.locations ?? []).map((l) => [l.id, l]));
  return { list, multi: list.length > 1, anyMulti: all.length > 1, byId, plan: q.data?.plan, isLoading: q.isLoading };
}
