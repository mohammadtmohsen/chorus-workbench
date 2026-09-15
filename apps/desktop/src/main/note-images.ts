import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dialog, protocol } from 'electron'
import { stashFile } from './stash.js'

/**
 * Where an image dropped into the global note actually lives.
 *
 * **A file beside the database, never inside the note.** A TipTap image node
 * carries a `src`, and the obvious `src` is a data URL — which would put the
 * bytes in the `app_note` row. That row is read whole on every launch, so ten
 * pasted screenshots would turn one startup read into tens of megabytes of
 * base64. The note holds a short URL instead and stays the size of its text.
 *
 * **Served by a private scheme rather than by path**, and that is forced rather
 * than chosen. `webSecurity` is on and the shell's own origin differs between
 * dev and a packaged build — `http://localhost` in one, `file://` in the other —
 * so an `<img src="file:///…">` works in exactly one of them. A scheme main owns
 * behaves the same in both and keeps the filesystem out of the renderer: the
 * renderer hands over bytes and receives a URL, and never learns a path.
 *
 * **The handler serves this one folder and nothing else.** Names are generated
 * here from a content hash, so anything that is not one is refused outright
 * rather than resolved and checked — there is no path to traverse when the only
 * accepted shape is sixteen hex characters and a known extension.
 */
export const NOTE_IMAGE_SCHEME = 'chorus-note'

/** The folder, under `userData`, holding every image any note refers to. */
const FOLDER = 'note-images'

/**
 * What may be stored and served.
 *
 * SVG is absent deliberately. It is a document rather than a bitmap, and while
 * an `<img>` will not run script in one, admitting it means the app stores a
 * file format whose safety depends on where it is later opened.
 */
const TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** Generated here, so anything else is a request that cannot be for our file. */
const NAME = /^[a-f0-9]{16}\.(png|jpg|jpeg|gif|webp)$/

function folderIn(userDataPath: string): string {
  return join(userDataPath, FOLDER)
}

/**
 * Declares the scheme before the app is ready, which is the only time it can be.
 *
 * `standard` so the URL parses with a host and a path rather than as an opaque
 * blob, and `secure` so a page on it is not treated as mixed content. No
 * `supportFetchAPI` and no `corsEnabled`: an `<img>` needs neither, and every
 * privilege granted here is one the renderer could reach for later.
 */
export function registerNoteImageScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: NOTE_IMAGE_SCHEME, privileges: { standard: true, secure: true } },
  ])
}

/** Serves the folder, after the app is ready. */
export function serveNoteImages(userDataPath: string): void {
  protocol.handle(NOTE_IMAGE_SCHEME, async (request) => {
    /*
     * The name is the whole path, taken from `pathname` and nothing else. A
     * `standard` scheme gives `chorus-note://image/<name>`, so the host carries
     * no information and is ignored; reading anything from it would be a second
     * place a caller could put a path.
     */
    const name = new URL(request.url).pathname.replace(/^\//, '')
    const type = NAME.test(name) ? TYPES[name.split('.').pop() ?? ''] : undefined
    if (type === undefined) return new Response(null, { status: 404 })
    try {
      const bytes = await readFile(join(folderIn(userDataPath), name))
      return new Response(new Uint8Array(bytes), { headers: { 'content-type': type } })
    } catch {
      // Deleted by hand, or written by a build that stored them elsewhere. A
      // note holding a broken image is better than a window that will not load.
      return new Response(null, { status: 404 })
    }
  })
}

/**
 * Stores bytes and answers with the URL the note should hold.
 *
 * **Named by content hash, so the same image pasted twice is one file.** It also
 * means the name says nothing about where the image came from, which matters for
 * something typed into a note: a screenshot's original filename is often the
 * only private thing about it.
 *
 * Nothing is ever deleted here. An image whose note no longer mentions it is
 * left on disk — reference counting a document somebody is still editing is a
 * way to delete the picture in an undo buffer, and the cost of not doing it is
 * disk rather than correctness.
 */
export async function saveNoteImage(
  userDataPath: string,
  bytes: Uint8Array,
  extension: string
): Promise<{ url: string }> {
  const ext = extension.toLowerCase().replace(/^\./, '')
  if (!(ext in TYPES)) throw new Error(`Unsupported image type: ${extension}`)
  const name = `${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.${ext}`
  const folder = folderIn(userDataPath)
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, name), bytes)
  return { url: `${NOTE_IMAGE_SCHEME}://image/${name}` }
}

export async function copyNoteImageTo(
  userDataPath: string,
  url: string
): Promise<{ path: string }> {
  const parsed = new URL(url)
  if (parsed.protocol !== `${NOTE_IMAGE_SCHEME}:`) {
    throw new Error(`That address is not a note image: ${url}`)
  }
  const name = parsed.pathname.replace(/^\//, '')
  if (!NAME.test(name)) throw new Error(`That name is not a note image: ${name}`)
  const bytes = await readFile(join(folderIn(userDataPath), name))
  return { path: stashFile(userDataPath, name, bytes.toString('base64')) }
}

/**
 * An address, fetched here and stored like anything else.
 *
 * **The renderer cannot do this and must not be able to.** `img-src` admits only
 * this process's own scheme, so a remote address written straight into the note
 * would render as a broken image; and `connect-src 'self'` means the renderer
 * could not fetch it either. Bringing the bytes across here is what lets an
 * address work at all while the shell's policy stays exactly as narrow.
 *
 * `http` and `https` only. A `file:` address would turn a text field into a way
 * to read any file on the machine and copy it somewhere the renderer can see,
 * which is the whole thing `pickNoteImage` exists to avoid.
 */
export async function fetchNoteImage(
  userDataPath: string,
  address: string
): Promise<{ url: string }> {
  const parsed = new URL(address)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https addresses can be fetched')
  }
  const response = await fetch(parsed.href)
  if (!response.ok) throw new Error(`That address answered ${String(response.status)}`)
  /*
   * The type decides the extension, not the address. A URL ending in `.png` says
   * what somebody named a route; the response header says what arrived, and only
   * one of the two is that file.
   */
  const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? ''
  const ext = Object.keys(TYPES).find((candidate) => TYPES[candidate] === type)
  if (ext === undefined) throw new Error(`That address is not an image: ${type}`)
  return saveNoteImage(userDataPath, new Uint8Array(await response.arrayBuffer()), ext)
}

/**
 * The picker, opened and read in main.
 *
 * Here rather than in the renderer so that choosing a file never hands the
 * renderer a path: it receives the same URL a paste would produce, and the only
 * thing that ever reads the filesystem is this process.
 *
 * Null when the dialog was cancelled, which is not an error and must not be
 * reported as one.
 */
export async function pickNoteImage(userDataPath: string): Promise<{ url: string | null }> {
  const picked = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: Object.keys(TYPES) }],
  })
  const path = picked.filePaths[0]
  if (picked.canceled || path === undefined) return { url: null }
  const bytes = await readFile(path)
  return saveNoteImage(userDataPath, new Uint8Array(bytes), path.split('.').pop() ?? '')
}
