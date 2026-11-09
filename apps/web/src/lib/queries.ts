import { useQuery } from '@tanstack/react-query';
import type { CustomerWithStats, ProfessionalDto, ServiceDto, SpaceDto } from '@agenda/shared';
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
