import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const SERVER_VERSION = (() => {
  try {
    return createRequire(import.meta.url)('../../package.json').version as string;
  } catch {
    return '0.0.0-dev';
  }
})();

const jsonObjectSchema = z.record(z.string(), z.unknown());
const queryParamsSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]));

type JsonObject = Record<string, unknown>;
type QueryParams = Record<string, string | number | boolean | string[]>;

interface AttioToolResult {
  readonly endpoint: string;
  readonly result: unknown;
  readonly count?: number;
}

type AttioStructuredContent = Record<string, unknown> & AttioToolResult;

interface AttioConfig {
  readonly baseUrl: URL;
  readonly token: string;
}

function resolveAttioConfig(env: NodeJS.ProcessEnv = process.env): AttioConfig {
  const token = env.ATTIO_API_TOKEN ?? env.ATTIO_API_KEY ?? env.ATTIO_ACCESS_TOKEN;
  if (!token || token.trim().length === 0) {
    throw new Error(
      'Missing Attio API token. Set ATTIO_API_TOKEN (preferred), ATTIO_API_KEY, or ATTIO_ACCESS_TOKEN before launching the server.'
    );
  }

  const rawBaseUrl = env.ATTIO_API_URL?.trim() || 'https://api.attio.com/v2';
  const normalizedBaseUrl = rawBaseUrl.endsWith('/') ? rawBaseUrl : `${rawBaseUrl}/`;
  return {
    baseUrl: new URL(normalizedBaseUrl),
    token: token.trim(),
  };
}

function buildUrl(baseUrl: URL, pathname: string, params?: QueryParams): URL {
  const normalizedPath = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  const url = new URL(normalizedPath, baseUrl);

  if (!params) {
    return url;
  }

  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        url.searchParams.append(key, entry);
      }
      continue;
    }
    url.searchParams.set(key, String(value));
  }

  return url;
}

async function attioRequest<TResponse = unknown>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  pathname: string,
  options: {
    readonly params?: QueryParams;
    readonly body?: JsonObject;
  } = {}
): Promise<TResponse> {
  const config = resolveAttioConfig();
  const url = buildUrl(config.baseUrl, pathname, options.params);

  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${config.token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      'User-Agent': `mcporter-attio-mcp/${SERVER_VERSION}`,
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });

  const rawText = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  const parsed = rawText.length === 0 ? null : contentType.includes('application/json') ? JSON.parse(rawText) : rawText;

  if (!response.ok) {
    const detail =
      typeof parsed === 'string'
        ? parsed
        : parsed && typeof parsed === 'object'
          ? JSON.stringify(parsed)
          : 'Request failed with no response body';
    throw new Error(`Attio API ${method} ${url.pathname} failed (${response.status}): ${detail}`);
  }

  return parsed as TResponse;
}

function summarizeResult(action: string, result: unknown): string {
  if (result && typeof result === 'object') {
    const envelope = result as { data?: unknown };
    if (Array.isArray(envelope.data)) {
      return `${action}: ${envelope.data.length} item(s)`;
    }
    if (envelope.data && typeof envelope.data === 'object') {
      const data = envelope.data as {
        id?: { record_id?: string; note_id?: string; task_id?: string; workspace_member_id?: string };
      };
      const id =
        data.id?.record_id ?? data.id?.note_id ?? data.id?.task_id ?? data.id?.workspace_member_id ?? undefined;
      return id ? `${action}: ${id}` : `${action}: ok`;
    }
  }

  return `${action}: ok`;
}

function createResult(
  endpoint: string,
  action: string,
  result: unknown
): { content: [{ type: 'text'; text: string }]; structuredContent: AttioStructuredContent } {
  const count =
    result && typeof result === 'object' && Array.isArray((result as { data?: unknown }).data)
      ? (result as { data: unknown[] }).data.length
      : undefined;
  const structuredContent: AttioStructuredContent = {
    endpoint,
    result,
    ...(typeof count === 'number' ? { count } : {}),
  };

  return {
    content: [{ type: 'text', text: summarizeResult(action, result) }],
    structuredContent,
  };
}

function compactObject<T extends JsonObject>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

export function createAttioMcpServer(): McpServer {
  const server = new McpServer({
    name: 'attio-api',
    version: SERVER_VERSION,
  });

  server.registerTool(
    'list-objects',
    {
      title: 'List Objects',
      description: 'List Attio objects available in the workspace.',
      inputSchema: {},
      outputSchema: {
        endpoint: z.string(),
        result: z.unknown(),
        count: z.number().optional(),
      },
    },
    async () => {
      const endpoint = '/objects';
      const result = await attioRequest('GET', endpoint);
      return createResult(endpoint, 'list-objects', result);
    }
  );

  server.registerTool(
    'list-attribute-definitions',
    {
      title: 'List Attribute Definitions',
      description: 'List Attio attribute definitions for a specific object or list.',
      inputSchema: {
        target: z.enum(['objects', 'lists']).describe("Use 'objects' for Attio objects or 'lists' for Attio lists."),
        identifier: z.string().describe('Object slug or list slug.'),
        params: queryParamsSchema.optional().describe('Optional scalar query params accepted by Attio.'),
      },
      outputSchema: {
        endpoint: z.string(),
        result: z.unknown(),
        count: z.number().optional(),
      },
    },
    async ({ target, identifier, params }) => {
      const endpoint = `/${target}/${identifier}/attributes`;
      const result = await attioRequest('GET', endpoint, { params });
      return createResult(endpoint, 'list-attribute-definitions', result);
    }
  );

  server.registerTool(
    'search-records',
    {
      title: 'Search Records',
      description: 'Fuzzy-search Attio records across one or more objects.',
      inputSchema: {
        query: z.string().optional().describe('Top-level text query to merge into the request body.'),
        object_slugs: z.array(z.string()).optional().describe('Optional object slugs to constrain the search.'),
        limit: z.number().int().positive().optional().describe('Optional page size to merge into the request body.'),
        offset: z.number().int().nonnegative().optional().describe('Optional offset to merge into the request body.'),
        body: jsonObjectSchema
          .optional()
          .describe('Raw Attio request body. Use this for alpha filters/sorts the public docs support.'),
      },
      outputSchema: {
        endpoint: z.string(),
        result: z.unknown(),
        count: z.number().optional(),
      },
    },
    async ({ query, object_slugs: objectSlugs, limit, offset, body }) => {
      const endpoint = '/objects/records/search';
      const requestBody = compactObject({
        ...body,
        query: query ?? body?.query,
        object_slugs: objectSlugs ?? (Array.isArray(body?.object_slugs) ? body.object_slugs : undefined),
        limit: limit ?? body?.limit,
        offset: offset ?? body?.offset,
      });

      if (Object.keys(requestBody).length === 0) {
        throw new Error('search-records requires either query, object_slugs, limit/offset, or a non-empty body.');
      }

      const result = await attioRequest('POST', endpoint, { body: requestBody });
      return createResult(endpoint, 'search-records', result);
    }
  );

  server.registerTool(
    'list-records',
    {
      title: 'List Records',
      description: 'List records for a specific Attio object, with optional filters and sorts.',
      inputSchema: {
        object: z.string().describe('Object slug, for example people or companies.'),
        body: jsonObjectSchema.optional().describe('Raw Attio request body for list filters, sorts, or pagination.'),
      },
      outputSchema: {
        endpoint: z.string(),
        result: z.unknown(),
        count: z.number().optional(),
      },
    },
    async ({ object, body }) => {
      const endpoint = `/objects/${object}/records/query`;
      const result = await attioRequest('POST', endpoint, { body: body ?? {} });
      return createResult(endpoint, 'list-records', result);
    }
  );

  server.registerTool(
    'get-record',
    {
      title: 'Get Record',
      description: 'Get a single Attio record by record ID.',
      inputSchema: {
        object: z.string().describe('Object slug, for example people or companies.'),
        record_id: z.string().describe('Attio record ID.'),
      },
      outputSchema: {
        endpoint: z.string(),
        result: z.unknown(),
      },
    },
    async ({ object, record_id: recordId }) => {
      const endpoint = `/objects/${object}/records/${recordId}`;
      const result = await attioRequest('GET', endpoint);
      return createResult(endpoint, 'get-record', result);
    }
  );

  server.registerTool(
    'create-record',
    {
      title: 'Create Record',
      description: 'Create an Attio record for the provided object.',
      inputSchema: {
        object: z.string().describe('Object slug, for example people or companies.'),
        data: jsonObjectSchema.describe('Raw Attio create-record body.'),
      },
      outputSchema: {
        endpoint: z.string(),
        result: z.unknown(),
      },
    },
    async ({ object, data }) => {
      const endpoint = `/objects/${object}/records`;
      const result = await attioRequest('POST', endpoint, { body: data });
      return createResult(endpoint, 'create-record', result);
    }
  );

  server.registerTool(
    'assert-record',
    {
      title: 'Assert Record',
      description: 'Create or update an Attio record using a matching attribute.',
      inputSchema: {
        object: z.string().describe('Object slug, for example people or companies.'),
        matching_attribute: z.string().optional().describe('Matching attribute slug to merge into the request body.'),
        data: jsonObjectSchema.describe('Raw Attio assert-record body.'),
      },
      outputSchema: {
        endpoint: z.string(),
        result: z.unknown(),
      },
    },
    async ({ object, matching_attribute: matchingAttribute, data }) => {
      const endpoint = `/objects/${object}/records`;
      const requestBody = compactObject({
        ...data,
        matching_attribute: matchingAttribute ?? data.matching_attribute,
      });
      const result = await attioRequest('PUT', endpoint, { body: requestBody });
      return createResult(endpoint, 'assert-record', result);
    }
  );

  server.registerTool(
    'list-notes',
    {
      title: 'List Notes',
      description: 'List Attio notes using optional scalar query params.',
      inputSchema: {
        params: queryParamsSchema.optional().describe('Optional Attio note query params such as limit or offset.'),
      },
      outputSchema: {
        endpoint: z.string(),
        result: z.unknown(),
        count: z.number().optional(),
      },
    },
    async ({ params }) => {
      const endpoint = '/notes';
      const result = await attioRequest('GET', endpoint, { params });
      return createResult(endpoint, 'list-notes', result);
    }
  );

  server.registerTool(
    'get-note',
    {
      title: 'Get Note',
      description: 'Fetch a single Attio note by ID.',
      inputSchema: {
        note_id: z.string().describe('Attio note ID.'),
      },
      outputSchema: {
        endpoint: z.string(),
        result: z.unknown(),
      },
    },
    async ({ note_id: noteId }) => {
      const endpoint = `/notes/${noteId}`;
      const result = await attioRequest('GET', endpoint);
      return createResult(endpoint, 'get-note', result);
    }
  );

  server.registerTool(
    'create-note',
    {
      title: 'Create Note',
      description: 'Create a note in Attio.',
      inputSchema: {
        data: jsonObjectSchema.describe('Raw Attio create-note body.'),
      },
      outputSchema: {
        endpoint: z.string(),
        result: z.unknown(),
      },
    },
    async ({ data }) => {
      const endpoint = '/notes';
      const result = await attioRequest('POST', endpoint, { body: data });
      return createResult(endpoint, 'create-note', result);
    }
  );

  server.registerTool(
    'list-tasks',
    {
      title: 'List Tasks',
      description: 'List Attio tasks using optional scalar query params.',
      inputSchema: {
        params: queryParamsSchema.optional().describe('Optional Attio task query params such as limit or offset.'),
      },
      outputSchema: {
        endpoint: z.string(),
        result: z.unknown(),
        count: z.number().optional(),
      },
    },
    async ({ params }) => {
      const endpoint = '/tasks';
      const result = await attioRequest('GET', endpoint, { params });
      return createResult(endpoint, 'list-tasks', result);
    }
  );

  server.registerTool(
    'get-task',
    {
      title: 'Get Task',
      description: 'Fetch a single Attio task by ID.',
      inputSchema: {
        task_id: z.string().describe('Attio task ID.'),
      },
      outputSchema: {
        endpoint: z.string(),
        result: z.unknown(),
      },
    },
    async ({ task_id: taskId }) => {
      const endpoint = `/tasks/${taskId}`;
      const result = await attioRequest('GET', endpoint);
      return createResult(endpoint, 'get-task', result);
    }
  );

  server.registerTool(
    'create-task',
    {
      title: 'Create Task',
      description: 'Create a task in Attio.',
      inputSchema: {
        data: jsonObjectSchema.describe('Raw Attio create-task body.'),
      },
      outputSchema: {
        endpoint: z.string(),
        result: z.unknown(),
      },
    },
    async ({ data }) => {
      const endpoint = '/tasks';
      const result = await attioRequest('POST', endpoint, { body: data });
      return createResult(endpoint, 'create-task', result);
    }
  );

  server.registerTool(
    'update-task',
    {
      title: 'Update Task',
      description:
        'Update an Attio task by ID. Attio currently documents deadline_at, is_completed, linked_records, and assignees as mutable.',
      inputSchema: {
        task_id: z.string().describe('Attio task ID.'),
        data: jsonObjectSchema.describe('Raw Attio update-task body.'),
      },
      outputSchema: {
        endpoint: z.string(),
        result: z.unknown(),
      },
    },
    async ({ task_id: taskId, data }) => {
      const endpoint = `/tasks/${taskId}`;
      const result = await attioRequest('PATCH', endpoint, { body: data });
      return createResult(endpoint, 'update-task', result);
    }
  );

  server.registerTool(
    'list-workspace-members',
    {
      title: 'List Workspace Members',
      description: 'List Attio workspace members.',
      inputSchema: {
        params: queryParamsSchema
          .optional()
          .describe('Optional Attio workspace member query params such as limit or offset.'),
      },
      outputSchema: {
        endpoint: z.string(),
        result: z.unknown(),
        count: z.number().optional(),
      },
    },
    async ({ params }) => {
      const endpoint = '/workspace_members';
      const result = await attioRequest('GET', endpoint, { params });
      return createResult(endpoint, 'list-workspace-members', result);
    }
  );

  server.registerTool(
    'get-workspace-member',
    {
      title: 'Get Workspace Member',
      description: 'Fetch a single Attio workspace member by ID.',
      inputSchema: {
        workspace_member_id: z.string().describe('Attio workspace member ID.'),
      },
      outputSchema: {
        endpoint: z.string(),
        result: z.unknown(),
      },
    },
    async ({ workspace_member_id: workspaceMemberId }) => {
      const endpoint = `/workspace_members/${workspaceMemberId}`;
      const result = await attioRequest('GET', endpoint);
      return createResult(endpoint, 'get-workspace-member', result);
    }
  );

  return server;
}
