import { useQuery } from '@tanstack/react-query';
import type { CustomerWithStats, ProfessionalDto, ServiceDto, SpaceDto } from '@agenda/shared';
import { api } from './api';

export const useServices = () =>
  useQuery({ queryKey: ['services'], queryFn: () => api<ServiceDto[]>('/services') });

export const useCustomers = (q = '', sort = 'name') =>
  useQuery({
    queryKey: ['customers', q, sort],
    queryFn: () =>
      api<{ items: CustomerWithStats[]; total: number }>(
        `/customers?limit=200&sort=${sort}${q ? `&q=${encodeURIComponent(q)}` : ''}`,
      ),
  });

export const useProfessionals = (enabled = true) =>
  useQuery({ queryKey: ['professionals'], queryFn: () => api<ProfessionalDto[]>('/professionals'), enabled });

export const useSpaces = (enabled = true) =>
  useQuery({ queryKey: ['spaces'], queryFn: () => api<SpaceDto[]>('/spaces'), enabled });
