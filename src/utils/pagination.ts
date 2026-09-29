export interface PageParams {
  page: number;
  pageSize: number;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export function parsePageParams(query: URLSearchParams): PageParams {
  const page = Math.max(1, parseInt(query.get("page") ?? "1", 10) || 1);
  const pageSize = Math.min(
    200,
    Math.max(1, parseInt(query.get("pageSize") ?? "50", 10) || 50)
  );
  return { page, pageSize };
}

export function paginate<T>(
  rows: T[],
  total: number,
  params: PageParams
): Paginated<T> {
  return {
    items: rows,
    page: params.page,
    pageSize: params.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / params.pageSize)),
  };
}
