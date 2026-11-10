import { useQuery } from '@tanstack/react-query';
import type { CustomerWithStats, LocationDto, PlanDto, ResourceDto, ServiceDto } from '@agenda/shared';
import { api } from './api';

export const useServices = () =>
  useQuery({ queryKey: ['services'], queryFn: () => api<ServiceDto[]>('/services') });

/** `forBooking` lets a colaborador find any existing customer by name/phone when booking. */
export const useCustomers = (q = '', sort = 'name', forBooking = false, page?: { size: number; index: number }) =>
  useQuery({
    queryKey: ['customers', q, sort, forBooking, page?.size, page?.index],
    queryFn: () =>
      api<{ items: CustomerWithStats[]; total: number }>(
        `/customers?limit=${page?.size ?? 200}&offset=${page ? page.size * page.index : 0}&sort=${sort}${q ? `&q=${encodeURIComponent(q)}` : ''}${forBooking ? '&for=booking' : ''}`,
      ),
    placeholderData: (prev) => prev,
  });

/** Whatever gets booked: team members, instructors, courts, rooms or tables. */
export const useResources = (enabled = true) =>
  useQuery({ queryKey: ['resources'], queryFn: () => api<ResourceDto[]>('/resources'), enabled });

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
