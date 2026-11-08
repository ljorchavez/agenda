import { useQuery } from '@tanstack/react-query';
import type { CustomerWithStats, ServiceDto } from '@agenda/shared';
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
