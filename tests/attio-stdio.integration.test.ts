import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CLI_ENTRY = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const PNPM_COMMAND = process.platform === 'win32' ? 'cmd.exe' : 'pnpm';
const PNPM_ARGS_PREFIX = process.platform === 'win32' ? ['/d', '/s', '/c', 'pnpm'] : [];

function pnpmArgs(args: string[]): string[] {
  return [...PNPM_ARGS_PREFIX, ...args];
}

async function ensureDistBuilt(): Promise<void> {
  try {
    await fs.access(CLI_ENTRY);
  } catch {
    await new Promise<void>((resolve, reject) => {
      execFile(PNPM_COMMAND, pnpmArgs(['build']), { cwd: process.cwd(), env: process.env }, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

async function runCli(args: string[], configPath: string): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [CLI_ENTRY, '--config', configPath, ...args],
      {
        cwd: process.cwd(),
        env: { ...process.env, MCPORTER_NO_FORCE_EXIT: '1' },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${error.message}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

describe('Attio stdio MCP server', () => {
  let tempDir: string;
  let configPath: string;
  let httpServer: HttpServer;
  let baseUrl: string;

  const app = express();
  app.use(express.json());

  app.get('/v2/objects', (_req, res) => {
    res.json({
      data: [
        { api_slug: 'people', singular_noun: 'person', plural_noun: 'people' },
        { api_slug: 'companies', singular_noun: 'company', plural_noun: 'companies' },
      ],
    });
  });

  app.post('/v2/objects/records/search', (req, res) => {
    expect(req.header('authorization')).toBe('Bearer attio-test-token');
    expect(req.body.query).toBe('Alice');
    expect(req.body.object_slugs).toEqual(['people']);
    res.json({
      data: [
        {
          id: { record_id: 'rec_person_123' },
          values: { name: [{ value: 'Alice Example' }] },
        },
      ],
    });
  });

  app.get('/v2/objects/people/records/rec_person_123', (req, res) => {
    expect(req.header('authorization')).toBe('Bearer attio-test-token');
    res.json({
      data: {
        id: { record_id: 'rec_person_123' },
        values: { name: [{ value: 'Alice Example' }] },
      },
    });
  });

  app.post('/v2/notes', (req, res) => {
    expect(req.header('authorization')).toBe('Bearer attio-test-token');
    expect(req.body).toEqual({
      parent_object: 'people',
      parent_record_id: 'rec_person_123',
      format: 'plaintext',
      content: 'Followed up after the meeting',
    });
    res.json({
      data: {
        id: { note_id: 'note_123' },
        content_plaintext: 'Followed up after the meeting',
      },
    });
  });

  app.patch('/v2/tasks/task_123', (req, res) => {
    expect(req.header('authorization')).toBe('Bearer attio-test-token');
    expect(req.body).toEqual({
      is_completed: true,
    });
    res.json({
      data: {
        id: { task_id: 'task_123' },
        is_completed: true,
      },
    });
  });

  beforeAll(async () => {
    await ensureDistBuilt();

    httpServer = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      httpServer.once('listening', resolve);
      httpServer.once('error', reject);
    });

    const address = httpServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP address for the Attio mock server.');
    }
    baseUrl = `http://127.0.0.1:${address.port}/v2`;

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-attio-stdio-'));
    configPath = path.join(tempDir, 'attio.config.json');
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            attioLocal: {
              description: 'Local Attio stdio MCP for integration tests',
              command: PNPM_COMMAND,
              args: pnpmArgs(['--dir', process.cwd(), 'attio:mcp']),
              env: {
                ATTIO_API_TOKEN: 'attio-test-token',
                ATTIO_API_URL: baseUrl,
              },
            },
          },
        },
        null,
        2
      ),
      'utf8'
    );
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it('lists the Attio tool surface via mcporter', async () => {
    const result = await runCli(['list', 'attioLocal'], configPath);
    expect(result.stdout).toContain('search-records');
    expect(result.stdout).toContain('create-note');
    expect(result.stdout).toContain('update-task');
    expect(result.stdout).toContain('list-workspace-members');
  }, 20000);

  it('proxies record reads and searches through the Attio API', async () => {
    const searchResult = await runCli(
      [
        'call',
        'attioLocal.search-records',
        '--output',
        'json',
        '--args',
        JSON.stringify({ query: 'Alice', object_slugs: ['people'] }),
      ],
      configPath
    );
    expect(searchResult.stdout).toContain('rec_person_123');
    expect(searchResult.stderr).toBe('');

    const getResult = await runCli(
      [
        'call',
        'attioLocal.get-record',
        '--output',
        'json',
        '--args',
        JSON.stringify({ object: 'people', record_id: 'rec_person_123' }),
      ],
      configPath
    );
    expect(getResult.stdout).toContain('Alice Example');
  }, 20000);

  it('creates notes and updates tasks through the Attio API', async () => {
    const noteResult = await runCli(
      [
        'call',
        'attioLocal.create-note',
        '--output',
        'json',
        '--args',
        JSON.stringify({
          data: {
            parent_object: 'people',
            parent_record_id: 'rec_person_123',
            format: 'plaintext',
            content: 'Followed up after the meeting',
          },
        }),
      ],
      configPath
    );
    expect(noteResult.stdout).toContain('note_123');

    const taskResult = await runCli(
      [
        'call',
        'attioLocal.update-task',
        '--output',
        'json',
        '--args',
        JSON.stringify({
          task_id: 'task_123',
          data: {
            is_completed: true,
          },
        }),
      ],
      configPath
    );
    expect(taskResult.stdout).toContain('task_123');
    expect(taskResult.stdout).toContain('true');
  }, 20000);
});
