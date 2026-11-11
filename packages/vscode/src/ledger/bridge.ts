// A Unix-socket HTTP endpoint per extension host. The mod pings it right after
// writing a batch, so Claude's edits show without waiting on a file watcher,
// and asks it to open a review diff or reveal the view.

import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as http from 'node:http'
import * as net from 'node:net'
import * as path from 'node:path'
import { z } from 'zod'

import type { Log } from '../log'
import { isMissing } from './fsx'
import { socketsDir } from './layout'

const MAX_BODY = 4096
/** macOS limits a Unix socket's path to 104 bytes, the terminating NUL included. */
const MAX_SOCKET_PATH = 103

const pingSchema = z.object({ ledger: z.string().min(1) })
const openSchema = z.object({ ledger: z.string().min(1), path: z.string().min(1), line: z.number().int().nonnegative().optional() })

export type OpenRequest = z.infer<typeof openSchema>

export type BridgeHandlers = {
  readonly onPing: (ledger: string) => void
  /** True when the path is under review here and its diff was shown. */
  readonly onOpen: (request: OpenRequest) => Promise<boolean>
  readonly onFocus: () => Promise<void>
}

const isListening = (socket: string): Promise<boolean> =>
  new Promise(resolve => {
    const conn = net.connect(socket)
    conn.once('connect', () => {
      conn.destroy()
      resolve(true)
    })
    conn.once('error', () => resolve(false))
  })

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    // Not JSON: the schema below rejects undefined.
    return undefined
  }
}

export class Bridge {
  private server: http.Server | undefined
  private socket: string | undefined

  constructor(
    private readonly handlers: BridgeHandlers,
    private readonly log: Log,
  ) {}

  get socketPath(): string | undefined {
    return this.socket
  }

  async start(dataDir: string): Promise<void> {
    const dir = socketsDir(dataDir)
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    await fs.chmod(dir, 0o700)
    await this.removeStale(dir)
    const socket = path.join(dir, `${process.pid.toString(36)}${randomBytes(2).toString('hex')}.sock`)
    if (Buffer.byteLength(socket) > MAX_SOCKET_PATH) throw new Error(`the socket path is too long for the OS: ${socket}`)
    const server = http.createServer((req, res) => {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => {
        body += chunk
        if (body.length > MAX_BODY) {
          res.writeHead(413).end()
          req.destroy()
        }
      })
      req.on('end', () => {
        void this.route(req.method ?? '', req.url ?? '', body).then(
          ({ status, json }) => (json === undefined ? res.writeHead(status).end() : res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json))),
          (err: unknown) => {
            this.log.error(`bridge ${req.url ?? ''}`, err)
            res.writeHead(500).end()
          },
        )
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socket, () => resolve())
    })
    server.on('error', err => this.log.error('the bridge socket', err))
    this.server = server
    this.socket = socket
  }

  dispose(): void {
    this.server?.close()
    if (this.socket) void fs.rm(this.socket, { force: true })
  }

  private async route(method: string, url: string, body: string): Promise<{ status: number; json?: unknown }> {
    if (method !== 'POST') return { status: 405 }
    switch (url) {
      case '/ping': {
        const parsed = pingSchema.safeParse(parseJson(body))
        if (!parsed.success) return { status: 400 }
        this.handlers.onPing(parsed.data.ledger)
        return { status: 204 }
      }
      case '/open': {
        const parsed = openSchema.safeParse(parseJson(body))
        if (!parsed.success) return { status: 400 }
        return (await this.handlers.onOpen(parsed.data)) ? { status: 200, json: { opened: true } } : { status: 404 }
      }
      case '/focus':
        await this.handlers.onFocus()
        return { status: 204 }
      default:
        return { status: 404 }
    }
  }

  /** Sockets left by extension hosts that are gone. */
  private async removeStale(dir: string): Promise<void> {
    const names = await fs.readdir(dir).catch((err: unknown) => {
      if (!isMissing(err)) this.log.error('listing sockets', err)
      return []
    })
    await Promise.all(
      names
        .filter(n => n.endsWith('.sock'))
        .map(async n => {
          const socket = path.join(dir, n)
          if (!(await isListening(socket))) await fs.rm(socket, { force: true })
        }),
    )
  }
}
