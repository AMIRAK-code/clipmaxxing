export function resolveSafe(root: string, urlPath: string): string | null;
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | null;
export function contentType(file: string): string;
export function createHandler(root: string): (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void;
export function startStaticServer(root: string, port?: number): Promise<{ port: number; origin: string; close: () => Promise<void> }>;
export function keyToUrl(origin: string, key: string): string;
export function assetBaseToServer(origin: string, assetBaseUrl: string): string;
