#!/usr/bin/env npx tsx
/**
 * =============================================================================
 *  NETTRUYEN.GG SCRAPER  —  TypeScript / Node.js >= 18  (chỉ cần `cheerio`)
 * =============================================================================
 *  Nguồn:  https://nettruyen.gg/trang-chu?page=<N>
 *  (trang này là catalogue đầy đủ của site — mỗi page chứa ~36 truyện,
 *   khối phân trang cuối trang cho biết tổng số trang, ví dụ 762)
 *
 *  Với MỖI TRUYỆN thu thập:
 *    • name (tên truyện), otherNames (tên khác/alias), slug, comicId, url, thumbnail
 *    • author (tác giả)
 *    • genres[] (thể loại)
 *    • status (tình trạng: Đang tiến hành / Hoàn thành / ...)
 *    • views (lượt xem — số thật + text gốc "13.871", "46K")
 *    • rating (xếp hạng: điểm TB / điểm tối đa / số lượt đánh giá)
 *    • follows, comments, likes
 *    • description (mô tả đã lọc boilerplate SEO) + descriptionRaw
 *    • updatedAtRelative ("30 phút trước") + updatedAtExact ("2026-09-26 20:48:06")
 *    • firstChapter / latestChapter / latestChapterNumberFromTitle ("Tới Chap 1295")
 *    • chapters[]: mỗi chương có { number, title, url, chapterId,
 *          views (lượt xem của chương), updatedAtText (cập nhật lúc mấy giờ), content }
 *    • chapters[].content: { imageCount (số ảnh trong chương), images[] (URL ảnh),
 *          imageHosts[], pageElements, htmlLength }
 *
 *  MỘT FILE DUY NHẤT — 4 chế độ chạy (không cần module nào khác ngoài `cheerio`):
 *    1) QUÉT      : npx tsx nettruyen.ts                       → hỏi số trang, ví dụ nhập 762
 *                   npx tsx nettruyen.ts --pages 762           → quét page/1 → page/762
 *                   npx tsx nettruyen.ts --pages 762 --no-details   (chỉ dữ liệu trang danh sách)
 *    2) TẢI ẢNH   : ... --save-images data/images              → lưu từng ảnh chương + ghi đường dẫn vào JSON
 *    3) BÙ DỮ LIỆU: npx tsx nettruyen.ts --enrich data/catalog.jsonl --limit 500
 *                   → chạy giai đoạn 2 cho catalogue đã có (tác giả/xếp hạng/chương/ảnh)
 *    4) BÁO CÁO   : npx tsx nettruyen.ts --report data/catalog.json.gz --md R.md --csv S.csv
 *                   → thống kê + CSV từ file đã thu thập (.json/.jsonl/.json.gz/stdin)
 *
 *  Output: JSON (mặc định data/nettruyen-<time>.json, có thể .gz) + JSONL ghi dần để resume.
 *  Chi tiết flags: xem --help. Site chạy Cloudflare: script tự giới hạn tốc độ + retry/backoff,
 *  Ctrl+C sẽ ghi phần đã thu thập rồi mới thoát. Chỉ dùng cho mục đích học tập/cá nhân.
 * =============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { load, type Cheerio, type CheerioAPI } from 'cheerio';

/* ========================================================================== *
 *  1. TYPES & CẤU HÌNH
 * ========================================================================== */

type ChapterMode = 'none' | 'listed' | 'all';

export interface Config {
  baseUrl: string;
  startPage: number;
  /** 0 = chưa nhập → sẽ hỏi người dùng. */
  endPage: number;
  outFile: string;
  jsonlFile: string;
  resume: boolean;
  details: boolean;
  chapterMode: ChapterMode;
  /** 0 = không giới hạn. */
  chapterLimit: number;
  /** 0 = không giới hạn. */
  storyLimitPerPage: number;
  /** Thư mục lưu ảnh chương (rỗng = không tải ảnh, chỉ đếm). */
  saveImages: string;
  /** Bù dữ liệu chi tiết cho catalogue đã có (file .json/.jsonl) thay vì quét lại trang danh sách. */
  enrichFrom: string;
  /** Chế độ báo cáo: file .json/.jsonl cần thống kê ('-' = đọc stdin). */
  reportFrom: string;
  csvFile: string;
  mdFile: string;
  reportTop: number;
  concurrency: number;
  /** nghỉ tối thiểu giữa 2 request (ms). */
  delay: number;
  timeout: number;
  retries: number;
  userAgent: string;
  verbose: boolean;
  /** auto = tự phát hiện TTY · tty = 1 dòng cập nhật tại chỗ · always = in dòng mới (pipe/file) · never = tắt. */
  progressMode: 'auto' | 'tty' | 'always' | 'never';
  /** khi không phải TTY: in dòng tiến độ mỗi N truyện. */
  progressEvery: number;
  /** và/hoặc in mỗi N ms cho dù chưa đủ N truyện. */
  progressEveryMs: number;
  /** --quiet: tắt log tiến độ (giữ cảnh báo + tổng kết). */
  quiet: boolean;
}

export interface ChapterContent {
  /** Số ảnh của chương (đã loại banner/notice của site). */
  imageCount: number;
  images: string[];
  /** Tổng phần tử .page-chapter (gồm cả ảnh notice chèn giữa truyện). */
  pageElements: number;
  imageHosts: string[];
  /** Độ dài HTML thô của trang chương. */
  htmlLength: number;
  /** --- các trường dưới đây chỉ có khi chạy --save-images --- */
  imageDir?: string;
  /** Đường dẫn file ảnh đã lưu, tương ứng thứ tự images[] (null = lỗi tải). */
  imageFiles?: (string | null)[];
  downloaded?: number;
  failedDownloads?: number;
  downloadedBytes?: number;
  error?: string;
  fetchedAt: string;
}

export interface ChapterInfo {
  number: number | null;
  title: string;
  url: string;
  chapterId: string | null;
  /** Lượt xem riêng của chương này. */
  views: number | null;
  viewsRaw: string | null;
  /** "29 phút trước" — thời gian cập nhật của chương. */
  updatedAtText: string | null;
  source: 'listing' | 'detail' | 'scan';
  content?: ChapterContent;
}

export interface Story {
  listingPage: number;
  url: string;
  slug: string;
  comicId: string | null;
  name: string;
  otherNames: string | null;
  author: string | null;
  genres: string[];
  status: string | null;
  views: number | null;
  viewsRaw: string | null;
  rating: { value: number | null; best: number | null; count: number | null };
  follows: number | null;
  comments: number | null;
  likes: number | null;
  description: string | null;
  descriptionRaw: string | null;
  descriptionSource: 'listing' | 'detail' | 'none';
  /** true = site không có mô tả thật, `description` chỉ là text SEO tự sinh. */
  descriptionIsBoilerplate: boolean;
  thumbnail: string | null;
  updatedAtRelative: string | null;
  /** "Cập nhật lúc: …" trên trang chi tiết truyện. */
  updatedAtExact: string | null;
  firstChapter: ChapterRef | null;
  latestChapter: ChapterRef | null;
  latestChapterNumberFromTitle: number | null;
  chapters: ChapterInfo[];
  chapterCount: number;
  scannedChapterCount: number;
  totalImages: number;
  detailError?: string;
  scrapedAt: string;
}

interface ChapterRef {
  number: number | null;
  title: string;
  url: string;
}

export const DEFAULTS: Config = {
  baseUrl: 'https://nettruyen.gg',
  startPage: 1,
  endPage: 0,
  outFile: '',
  jsonlFile: '',
  resume: false,
  details: true,
  chapterMode: 'listed',
  chapterLimit: 20,
  storyLimitPerPage: 0,
  saveImages: '',
  enrichFrom: '',
  reportFrom: '',
  csvFile: '',
  mdFile: '',
  reportTop: 10,
  concurrency: 5,
  delay: 150,
  timeout: 30_000,
  retries: 4,
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  verbose: false,
  progressMode: 'auto',
  progressEvery: 5,
  progressEveryMs: 8000,
  quiet: false,
};

const HELP = `
NETTRUYEN.GG SCRAPER
====================
  npx tsx nettruyen.ts [options]

Options:
  --pages <N>          Số trang cần quét, từ 1..N.            VD: --pages 762
  --pages <A-B>        Quét từ trang A tới B.                 VD: --pages 100-150
  --out <file.json>    File JSON kết quả (mặc định data/nettruyen-<time>.json; .gz = nén luôn)
  --jsonl <file>       File JSONL ghi dần trong lúc chạy (chống mất dữ liệu)
  --resume             Bỏ qua truyện đã có trong JSONL (chạy tiếp phần còn thiếu)
  --no-details         Chỉ quét trang danh sách (nhanh, thiếu tác giả/xếp hạng/chương)
  --chapters <mode>    none | listed | all   (mặc định: listed)
                        listed : quét đúng các chương site liệt kê ở trang truyện
                                 (site hiển thị ~20 chương mới nhất)
                        all    : quét TẤT CẢ chương từ 1..N (rất nhiều request!)
  --chapter-limit <n>  Giới hạn số chương quét ảnh/truyện (0 = tất cả, mặc định 20)
  --limit <n>          Chỉ lấy n truyện đầu của mỗi trang (dùng khi test)
  --enrich <file>      Bù tác giả/xếp hạng/chương/ảnh cho catalogue .json|.jsonl đã có
                       (lọc lại bằng --pages A-B và --limit N; dùng khi chạy 2 giai đoạn)
  --report <file>      CHỈ in báo cáo thống kê từ file .json/.jsonl đã có ('-' = stdin)
  --csv <file.csv>     khi dùng --report: xuất CSV (mỗi truyện 1 dòng, có BOM cho Excel)
  --md <file.md>       khi dùng --report: xuất file báo cáo Markdown
  --top <n>            khi dùng --report: số truyện trong bảng top lượt xem (mặc định 10)
  --save-images <dir>  Tải luôn ảnh của các chương đã quét về <dir> (mặc định: không tải)
  --concurrency <n>    Số request song song (mặc định 5)
  --delay <ms>         Nghỉ tối thiểu giữa 2 request (mặc định 150)
  --retries <n>        Số lần thử lại khi 403/429/5xx/mạng (mặc định 4)
  --timeout <ms>       Timeout 1 request (mặc định 30000)
  --base <url>         Đổi domain (site hay đổi tên miền: nettruyen.gg, ...)
  --progress <mode>    auto|tty|always|never — mặc định auto:
                         tty    : 1 dòng tự cập nhật tại chỗ (xem trên terminal)
                         always : in dòng MỚI mỗi --progress-every truyện (khi chạy "… | tee log.txt")
  --progress-every <n> Số truyện giữa 2 dòng tiến độ khi không phải TTY (mặc định 5)
  --progress-ms <ms>   Ngoài ra còn in mỗi N ms cho dù chưa đủ --progress-every (mặc định 8000)
  --quiet              Tắt log tiến độ (vẫn in cảnh báo + bảng tổng kết)
  --verbose            Log chi tiết từng chương / từng ảnh
  --help               Hiện trợ giúp

Ví dụ:
  npx tsx nettruyen.ts --pages 1 --limit 3 --chapter-limit 2      # test nhanh
  npx tsx nettruyen.ts --pages 762 --out data/full.json           # full catalogue
  npx tsx nettruyen.ts --pages 100-150 --chapters all --resume    # quét chương đầy đủ
`;

/* ========================================================================== *
 *  2. HTTP CLIENT — retry + backoff + giới hạn tốc độ + cookie
 * ========================================================================== */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class Http {
  private nextSlot = 0;
  private cookies = new Map<string, string>();
  /** số lần bị chặn/quá tải — dùng để cảnh báo cuối run. */
  blockedHits = 0;

  constructor(private cfg: Config) {}

  private cookieHeader(): string {
    return this.cookies.size
      ? [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
      : '';
  }

  /** Điều tiết: không gửi 2 request gần nhau hơn `delay` ms. */
  private async throttle(): Promise<void> {
    if (this.cfg.delay <= 0) return;
    const now = Date.now();
    const at = Math.max(now, this.nextSlot);
    this.nextSlot = at + this.cfg.delay;
    if (at > now) await sleep(at - now);
  }

  async get(url: string, referer?: string): Promise<{ status: number; body: string }> {
    let lastErr: Error = new Error('không rõ lỗi');
    for (let attempt = 0; attempt <= this.cfg.retries; attempt++) {
      if (attempt > 0) {
        const wait = Math.min(30_000, 900 * 2 ** (attempt - 1)) + Math.random() * 600;
        const msg = `retry ${attempt}/${this.cfg.retries} sau ${Math.round(wait / 100) / 10}s — ${lastErr.message.slice(0, 90)}`;
        if (this.cfg.verbose) console.log(`   ↻ ${msg} (${url})`);
        else progress.warn(msg);
        await sleep(wait);
      }
      await this.throttle();

      const headers: Record<string, string> = {
        'User-Agent': this.cfg.userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        DNT: '1',
        'Upgrade-Insecure-Requests': '1',
        Referer: referer ?? `${this.cfg.baseUrl}/trang-chu`,
      };
      const ck = this.cookieHeader();
      if (ck) headers.Cookie = ck;

      try {
        const res = await fetch(url, {
          headers,
          redirect: 'follow',
          signal: AbortSignal.timeout(this.cfg.timeout),
        });
        // giữ lại set-cookie để ổn định phiên với Cloudflare
        const setCookies: string[] =
          typeof (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === 'function'
            ? (res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
            : [];
        for (const c of setCookies) {
          const [pair] = c.split(';');
          const i = pair.indexOf('=');
          if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
        }

        const body = await res.text();

        if (res.status === 404 || res.status === 410) return { status: res.status, body };

        if (res.status === 403 || res.status === 429 || res.status >= 500 || /just a moment|Attention Required|cf-challenge/i.test(body.slice(0, 3000))) {
          this.blockedHits++;
          lastErr = new Error(
            `HTTP ${res.status} — nghi bị Cloudflare chặn (giảm --concurrency, tăng --delay)`,
          );
          continue;
        }
        return { status: res.status, body };
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw lastErr;
  }

  /** Tải 1 file nhị phân (ảnh) và ghi ra dest. */
  async download(url: string, dest: string, referer?: string): Promise<number> {
    let lastErr: Error = new Error('không rõ lỗi');
    for (let attempt = 0; attempt <= Math.min(2, this.cfg.retries); attempt++) {
      if (attempt > 0) await sleep(500 * 2 ** (attempt - 1) + Math.random() * 300);
      await this.throttle();
      try {
        const res = await fetch(url, {
          headers: {
            'User-Agent': this.cfg.userAgent,
            Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
            Referer: referer ?? this.cfg.baseUrl + '/',
            ...(this.cookies.size ? { Cookie: this.cookieHeader() } : {}),
          },
          signal: AbortSignal.timeout(this.cfg.timeout),
        });
        if (!res.ok) {
          lastErr = new Error(`HTTP ${res.status}`);
          continue;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 100) {
          lastErr = new Error(`file quá nhỏ (${buf.length}B) — có thể bị chặn`);
          continue;
        }
        fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
        fs.writeFileSync(dest, buf);
        return buf.length;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw lastErr;
  }

  /** HTML 200, ngoài ra ném lỗi (kèm 404 → dùng để bỏ chương không tồn tại). */
  async html(url: string, referer?: string): Promise<string> {
    const { status, body } = await this.get(url, referer);
    if (status !== 200) throw new Error(`HTTP ${status} — ${url}`);
    return body;
  }
}

/* ========================================================================== *
 *  3. TIỆN ÍCH PARSE
 * ========================================================================== */

/**
 * Parse số kiểu VN/viết tắt:  "13.871"→13871 · "2,725"→2725 · "46K"→46000
 * "1.2M"→1200000 · "1,054,564"→1054564 · "5/5"→5
 */
export function parseViNumber(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input) : null;

  let s = String(input).replace(/\u00a0/g, ' ').trim().replace(/\s+/g, '');
  if (!s) return null;

  // dạng tỉ lệ "4.5/5", "5/5" → lấy tử số
  if (/^\d+(?:[.,]\d+)?\/\d+$/.test(s)) s = s.split('/')[0];

  // hậu tố K / M / B / T (site dùng K, M cho lượt xem rút gọn)
  let mult = 1;
  const unit = s.match(/([kmbt])$/i)?.[1]?.toLowerCase();
  if (unit === 'k') mult = 1_000;
  else if (unit === 'm' || unit === 't') mult = 1_000_000;
  else if (unit === 'b') mult = 1_000_000_000;
  if (unit) s = s.slice(0, -1);

  s = s.replace(/[^\d.,]/g, '');
  if (!s) return null;

  const dot = s.indexOf('.');
  const comma = s.indexOf(',');
  if (dot >= 0 && comma >= 0) {
    // dấu xuất hiện sau cùng là phân cách thập phân, dấu còn lại là hàng nghìn
    const dec = dot > comma ? '.' : ',';
    const thou = dec === '.' ? ',' : '.';
    s = s.split(thou).join('').replace(dec, '.');
  } else {
    const sep = dot >= 0 ? '.' : comma >= 0 ? ',' : '';
    if (sep) {
      const parts = s.split(sep);
      const isThousands = parts.length > 1 && parts[0].length <= 3 && parts.slice(1).every((p) => p.length === 3);
      s = isThousands ? parts.join('') : parts.join('.'); // 1.5 → 1.5 (thập phân)
    }
  }

  const n = Number(s) * mult;
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Tổng số file ảnh đã tải của cả run. */
export function downloadedCount(stories: Story[]): number {
  return stories.reduce(
    (a, s) => a + s.chapters.reduce((b, c) => b + (c.content?.downloaded ?? 0), 0),
    0,
  );
}

/** Tổng dung lượng ảnh đã tải (MB). */
export function downloadedBytes(stories: Story[]): number {
  return stories.reduce(
    (a, s) => a + s.chapters.reduce((b, c) => b + (c.content?.downloadedBytes ?? 0), 0),
    0,
  );
}

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1) + 'MB';

/** Tên file an toàn (bỏ ký tự cấm, giữ tiếng Việt có dấu). */
function safeName(s: string): string {
  return s
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** Chuẩn hoá nhãn tiếng Việt để so khớp: bỏ dấu, bỏ ký tự lạ, lowercase.
 *  "Thể loại:" → "theloai", "Tác giả" → "tacgia", "Tên khác:" → "tenkhac" */
function normKey(s: string): string {
  return s
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z]/g, '')
    .toLowerCase();
}

/** Giá trị "Đang cập nhật" / rỗng coi như vô nghĩa → ưu tiên giá trị thật đã có. */
const WEAK = /^(đang cập nhật|cập nhật|n\/a|null|unknown|\?)$/i;
function better(existing: string | null, incoming: string | null): string | null {
  if (incoming && !WEAK.test(incoming.trim())) return incoming.trim();
  if (existing && !WEAK.test(existing.trim())) return existing.trim();
  return incoming ?? existing ?? null;
}

/** Mảng thể loại: giữ mảng đang có nếu mảng mới chỉ là "Đang cập nhật". */
function betterList(existing: string[], incoming: string[]): string[] {
  const clean = (a: string[]) => a.filter((x) => x && !WEAK.test(x.trim()));
  return clean(incoming).length ? clean(incoming) : clean(existing);
}

function cleanText(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Bỏ các đoạn text SEO tự động mà site chèn thêm vào mô tả. */
const SEO_PATTERNS: RegExp[] = [
  /^\s*Chào mừng các đạo hữu/i,
  /^\s*NetTruyen là website/i,
  /^\s*NetTruyen luôn cập nhật/i,
  /^\s*Hãy đến với NetTruyen/i,
  /^\s*Hãy đăng ký ngay/i,
  /^\s*Để trải nghiệm truyện tranh tốt nhất/i,
  /là một trong những tác phẩm nổi bật/i,
  /được chấp bút bởi NetTruyen/i,
  /Bộ truyện này thuộc về các thể loại/i,
  /và được cập nhật chap mới liên tục/i,
  /^Kể từ khi ra mắt,/i,
  /^Không chỉ hấp dẫn ở cốt truyện/i,
  /^Theo dõi .{0,120}trên NetTruyen để cập nhật/i,
  /^\s*[—–-]\s*xem thêm\s*[—–-]\s*$/i,
];

export function stripSeo(text: string): string {
  if (!text) return '';
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !SEO_PATTERNS.some((re) => re.test(l)))
    .join('\n')
    .trim();
}

function abs(url: string | undefined, base: string): string | null {
  if (!url) return null;
  const u = url.trim();
  if (!u || u === '#' || u.startsWith('javascript:') || u.startsWith('mailto:')) return null;
  if (u.startsWith('//')) return 'https:' + u;
  if (/^https?:\/\//i.test(u)) return u;
  return base + (u.startsWith('/') ? '' : '/') + u;
}

/** "…/chuong-123" → 123 · không có thì lấy số trong title. */
function chapterNumber(url: string | null, title: string | null): number | null {
  const m = url?.match(/\/chuong-(\d+(?:[.-]\d+)?)(?:[/?#]|$)/i);
  if (m) return Number(m[1].replace('-', '.'));
  const t = title?.match(/(\d+(?:[.,]\d+)?)/);
  if (t) return Number(t[1].replace(',', '.'));
  return null;
}

/** Đọc các cặp `<label>Nhãn:</label> giá trị` từ khối <p> đã chọn. */
/* ========================================================================== *
 *  3.5  LOG TIẾN ĐỘ
 *        - Terminal (TTY): một dòng duy nhất tự cập nhật tại chỗ (dùng \r).
 *        - Khi pipe/tee ra file (KHÔNG phải TTY): \r vô hình, nên tự động in
 *          THÀNH DÒNG MỚI mỗi `--progress-every` truyện hoặc mỗi 8 giây.
 *        Nhờ vậy lúc nào cũng thấy "đang cào tới đâu", kể cả giữa một trang
 *        (1 trang = 36 truyện × 16 request ≈ 1-2 phút) hay khi quét 1000+ chương.
 * ========================================================================== */

export interface ProgressInfo {
  /** trang danh sách hiện đang cào / tổng số trang phải cào. */
  page?: number;
  pagesTotal?: number;
  /** số trang đã hoàn thành (để tính %). */
  pagesDone?: number;
  /** truyện đã xong / tổng ước lượng. */
  done?: number;
  total?: number;
  /** nhãn truyện đang cào. */
  story?: string;
  /** giai đoạn trong truyện: "chap 7/20", "ảnh 12/42"… */
  sub?: string;
  failed?: number;
}

class Progress {
  private t0 = Date.now();
  private lastDraw = 0;
  private lastLineAt = 0;
  private sinceLine = 0;
  private mode: 'tty' | 'file' | 'off' = 'off';
  private everyN = 10;
  private everyMs = 8000;
  private line = '';
  warnings = 0;

  configure(opts: { mode: 'auto' | 'tty' | 'always' | 'never'; everyN: number; everyMs: number }): void {
    const tty = process.stdout.isTTY === true;
    this.mode =
      opts.mode === 'never' ? 'off'
      : opts.mode === 'always' ? 'file'
      : opts.mode === 'tty' ? 'tty'
      : tty ? 'tty' : 'file';
    this.everyN = Math.max(1, opts.everyN);
    this.everyMs = Math.max(500, opts.everyMs);
    this.t0 = Date.now();
  }

  /** true khi log tiến độ đang bật (--quiet / --progress never → false). */
  get active(): boolean {
    return this.mode !== 'off';
  }

  /** Im lặng hoàn toàn (vẫn in cảnh báo + tổng kết). */
  mute(): void {
    this.mode = 'off';
  }

  private fmt(info: ProgressInfo): string {
    const secs = Math.max(0.001, (Date.now() - this.t0) / 1000);
    const rate = (info.done ?? 0) / secs;
    const bits: string[] = [];
    if (info.page && info.pagesTotal) {
      const pct = Math.min(100, ((info.pagesDone ?? 0) / info.pagesTotal) * 100);
      bits.push(`trang ${info.page}/${info.pagesTotal}` + (pct > 0 ? ` ${pct.toFixed(1)}%` : ''));
    }
    // chưa biết tổng số truyện (đang tải trang danh sách) → đừng in "0 truyện" gây hiểu nhầm
    if (info.total) bits.push(`${info.done ?? 0}/${info.total} truyện`);
    else if (info.done) bits.push(`${info.done} truyện`);
    bits.push(`${rate.toFixed(1)}/s`);
    // ETA: chỉ ước lượng sau 3s (sớm hơn thì toàn ra số vô nghĩa)
    if (secs > 3) {
      if (info.page && info.pagesTotal && info.pagesTotal > 1) {
        const donePages2 = Math.max(1, info.pagesDone ?? 0);
        const remainPages = Math.max(0, info.pagesTotal - donePages2);
        bits.push(`còn ~${eta((remainPages * secs) / donePages2)}`);
      } else if ((info.total ?? 0) > (info.done ?? 0) && (info.done ?? 0) > 0) {
        bits.push(`còn ~${eta((secs / (info.done as number)) * ((info.total as number) - (info.done as number)))}`);
      }
    }
    if (info.failed) bits.push(`lỗi ${info.failed}`);
    if (info.story) bits.push(info.story.length > 46 ? info.story.slice(0, 44) + '…' : info.story);
    if (info.sub) bits.push(info.sub);
    return bits.join(' · ');
  }

  /**
   * Cập nhật trạng thái.
   *  - TTY  : vẽ lại tại chỗ (urgent = bỏ qua throttle 100ms)
   *  - file : in dòng mới theo --progress-every / --progress-ms, KHÔNG phụ thuộc urgent
   *           để run 27k truyện không sinh ra 55k dòng log.
   */
  tick(info: ProgressInfo, urgent = false): void {
    if (this.mode === 'off') return;
    this.line = this.fmt(info);
    this.sinceLine++;
    const now = Date.now();
    if (this.mode === 'tty') {
      if (!urgent && now - this.lastDraw < 60) return;
      this.lastDraw = now;
      process.stdout.write(`\r\x1b[K  ⏳ ${this.line}`);
      return;
    }
    if (this.sinceLine < this.everyN && now - this.lastLineAt < this.everyMs) return;
    this.lastLineAt = now;
    this.sinceLine = 0;
    console.log(`  ${stamp()} ⏳ ${this.line}`);
  }

  /** Dòng trạng thái: TTY vẽ tại chỗ, file in 1 dòng có timestamp. */
  status(text: string): void {
    if (this.mode === 'off') return;      // --quiet → không in dòng 'đang tải trang …'
    if (this.mode === 'tty') {
      this.line = text;
      process.stdout.write(`\r\x1b[K  ⏳ ${text}`);
      return;
    }
    console.log(`  ${stamp()} ▶ ${text}`);
    this.lastLineAt = Date.now();
    this.sinceLine = 0;
  }

  /**
   * In một dòng sự kiện (mốc mỗi trang). Ẩn khi --quiet/--progress never.
   * Tự clear dòng tiến độ đang vẽ rồi vẽ lại, nên không bao giờ lẫn chữ.
   */
  print(text: string): void {
    if (this.mode === 'off') return;
    if (this.mode === 'tty') {
      process.stdout.write('\r\x1b[K');
      console.log(text);
      if (this.line) process.stdout.write(`\r\x1b[K  ⏳ ${this.line}`);
    } else {
      console.log(`  ${stamp()} ${text}`);
    }
    this.lastLineAt = Date.now();
    this.sinceLine = 0;
  }

  /** Dòng BẤT THƯỜNG — luôn in, kể cả --quiet (kèm timestamp ở file mode). */
  event(text: string): void {
    if (this.mode === 'file') console.log(`  ${stamp()} ${text}`);
    else if (this.mode === 'tty') {
      process.stdout.write('\r\x1b[K');
      console.log(text);
      if (this.line) process.stdout.write(`\r\x1b[K  ⏳ ${this.line}`);
    } else console.log(text);
    this.lastLineAt = Date.now();
    this.sinceLine = 0;
  }

  /** Cảnh báo nhẹ (retry, bị chặn, ảnh lỗi) — đếm để tổng kết cuối run. */
  warn(text: string): void {
    this.warnings++;
    this.event(`⚠ ${text}`);
  }

  /** Kết thúc: trả dòng về đầu, xoá dòng tiến độ. */
  finish(): void {
    if (this.mode === 'tty') process.stdout.write('\r\x1b[K');
    this.line = '';
  }
}

/** "2026-09-26 21:04:11" → chỉ lấy giờ:phút:giây cho log chạy nền. */
function stamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

/** Giây → "1h02m" / "3m12s" / "48s". */
function eta(seconds: number): string {
  const s2 = Math.max(0, Math.round(seconds));
  const h = Math.floor(s2 / 3600);
  const m = Math.floor((s2 % 3600) / 60);
  const sec = s2 % 60;
  if (h) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

/** Singleton dùng chung (script 1 file nên không cần phụ thuộc request context). */
export const progress = new Progress();

/** Đọc các cặp `<label>Nhãn:</label> giá trị` từ khối <p> đã chọn. */
function readLabelPairs($: CheerioAPI, $root: Cheerio<any>): Record<string, string> {
  const map: Record<string, string> = {};
  $root
    .find('p')
    .each((_, el) => {
      const $p = $(el);
      const label = cleanText($p.find('label').text());
      if (!label) return;
      const full = cleanText($p.text());
      const value = full.slice(full.indexOf(label) + label.length).replace(/^[:\s]+/, '').trim();
      const key = normKey(label);
      if (key) map[key] = value;
    });
  return map;
}

/** Chạy n task song song có giới hạn, giữ thứ tự kết quả. */
async function runPool<T, R>(items: T[], limit: number, worker: (it: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(lanes);
  return out;
}

/* ========================================================================== *
 *  4. PARSER TRANG DANH SÁCH   /trang-chu?page=N
 *     Markup thực tế (đã kiểm chứng):
 *     <div class="item">
 *       <figure>
 *         <div class="image">
 *           <a title="Truyện tranh X" href="…/truyen-tranh/x">…</a>
 *           <div class="view clearfix"><span class="pull-left">
 *              <i class="fa fa-eye"></i> 41K <i class="fa fa-comment"></i> 0 <i class="fa fa-heart"></i> 189
 *           </span></div>
 *         </div>
 *         <figcaption>
 *           <h3><a class="jtip" data-jtip="#truyen-tranh-31630" href="…">X</a></h3>
 *           <ul class="comic-item" data-id="31630">
 *             <li class="chapter clearfix">
 *               <a data-id="90" href="…/chuong-56" title="Chapter 56">Chapter 56</a>
 *               <i class="time">36 phút trước</i>
 *             </li> …
 *           </ul>
 *         </figcaption>
 *       </figure>
 *       <div class="box_tootip" id="truyen-tranh-31630"><div class="box_li">
 *         <div class="title">X</div>
 *         <div class="message_main">
 *           <p><label>Tên khác:</label></p> <p><label>Thể loại:</label>Action,Manhua</p>
 *           <p><label>Tình trạng:</label>Hoàn Thành</p> <p><label>Lượt xem:</label> 4K</p>
 *           <p><label>Bình luận:</label> 14</p> <p><label>Theo dõi:</label> 990</p>
 *           <p><label>Ngày cập nhật:</label>11 năm trước</p>
 *         </div>
 *         <div class="box_text">…mô tả…</div>
 *       </div></div>
 *     </div>
 * ========================================================================== */

/** Tổng số trang từ khối phân trang (… 761 · 762 ›). */
export function detectTotalPages($: CheerioAPI): number | null {
  let max = 0;
  $('ul.pagination').first().find('a.page-link, span.page-link').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const q = href.match(/[?&]page=(\d+)/);
    const n = q ? Number(q[1]) : Number(cleanText($(el).text()));
    if (Number.isFinite(n) && n > max) max = n;
  });
  return max || null;
}

export function parseListingPage(html: string, cfg: Config, pageNo: number): Story[] {
  const $ = load(html);
  const stories: Story[] = [];
  const seen = new Set<string>();

  $('div.item').each((_, el) => {
    const $item = $(el);
    // chỉ nhận card của catalogue (figcaption); loại các module slide "Truyện đề cử"
    if (!$item.find('figcaption').length) return;

    const $a = $item.find('figcaption h3 a').first().length
      ? $item.find('figcaption h3 a').first()
      : $item.find('figcaption a').first();
    const url = abs($a.attr('href'), cfg.baseUrl);
    if (!url) return;
    const m = url.match(/\/truyen-tranh\/([^/?#]+)/i);
    if (!m) return;
    const slug = decodeURIComponent(m[1]);
    if (seen.has(slug)) return;
    seen.add(slug);

    const story: Story = {
      listingPage: pageNo,
      url: `${cfg.baseUrl}/truyen-tranh/${m[1]}`,
      slug,
      comicId: $item.find('ul.comic-item').attr('data-id') ?? $a.attr('data-jtip')?.replace('#truyen-tranh-', '') ?? null,
      name: cleanText($a.attr('title')?.replace(/^truyện tranh\s+/i, '') || $a.text()),
      otherNames: null,
      author: null,
      genres: [],
      status: null,
      views: null,
      viewsRaw: null,
      rating: { value: null, best: null, count: null },
      follows: null,
      comments: null,
      likes: null,
      description: null,
      descriptionRaw: null,
      descriptionSource: 'none',
      descriptionIsBoilerplate: false,
      thumbnail: null,
      updatedAtRelative: null,
      updatedAtExact: null,
      firstChapter: null,
      latestChapter: null,
      latestChapterNumberFromTitle: null,
      chapters: [],
      chapterCount: 0,
      scannedChapterCount: 0,
      totalImages: 0,
      scrapedAt: new Date().toISOString(),
    };

    // ---- ảnh bìa (lazy-load → nằm ở data-original/data-retries) ----
    const $img = $item.find('div.image img').first().length ? $item.find('div.image img').first() : $item.find('img').first();
    story.thumbnail = abs($img.attr('data-original') || $img.attr('data-retries') || $img.attr('src'), cfg.baseUrl);

    // ---- lượt xem / bình luận / thích trên card ----
    const viewHtml = $item.find('div.view').first().html() ?? '';
    const reIcons = /fa-(eye|comment|heart)[^>]*><\/i>\s*([\d.,]+\s*[KMBT]?)/gi;
    let mi: RegExpExecArray | null;
    while ((mi = reIcons.exec(viewHtml))) {
      const n = parseViNumber(mi[2]);
      const kind = mi[1].toLowerCase();
      if (kind === 'eye' && n !== null) {
        story.views = n;
        story.viewsRaw = cleanText(mi[2]);
      } else if (kind === 'comment') story.comments = n;
      else if (kind === 'heart') story.likes = n;
    }

    // ---- 3 chương mới nhất trên card ----
    $item.find('ul.comic-item li').each((_, li) => {
      const $li = $(li);
      const $ca = $li.find('a').first();
      const chUrl = abs($ca.attr('href'), cfg.baseUrl);
      if (!chUrl) return;
      const time = cleanText($li.find('i.time').text());
      if (time && !story.updatedAtRelative) story.updatedAtRelative = time;
      const title = cleanText($ca.attr('title') || $ca.text());
      story.chapters.push({
        number: chapterNumber(chUrl, title),
        title,
        url: chUrl,
        chapterId: $ca.attr('data-id') ?? null,
        views: null,
        viewsRaw: null,
        updatedAtText: time || null,
        source: 'listing',
      });
      if (!story.latestChapter) story.latestChapter = { number: chapterNumber(chUrl, title), title, url: chUrl };
    });

    // ---- tooltip: tên khác / thể loại / tình trạng / lượt xem / bình luận / theo dõi / ngày cập nhật ----
    const pairs = readLabelPairs($, $item.find('.box_tootip .message_main').first());
    for (const [key, value] of Object.entries(pairs)) {
      if (!value) continue;
      if (key.startsWith('tenkhac')) story.otherNames = value;
      else if (key.startsWith('theloai')) story.genres = value.split(',').map((g) => g.trim()).filter(Boolean);
      else if (key.startsWith('tinhtrang')) story.status = value;
      else if (key.startsWith('luotxem')) {
        story.viewsRaw = story.viewsRaw ?? value;
        story.views = parseViNumber(value) ?? story.views;
      } else if (key.startsWith('binhluan')) story.comments = parseViNumber(value) ?? story.comments;
      else if (key.startsWith('theodoi')) story.follows = parseViNumber(value);
      else if (key.startsWith('ngaycapnhat')) story.updatedAtRelative = value;
    }

    // ---- mô tả ----
    const raw = cleanText($item.find('.box_text').first().text());
    if (raw) {
      const cleaned = stripSeo(raw);
      story.descriptionRaw = raw;
      story.description = cleaned || raw; // không có bản sạch thì vẫn giữ nguyên văn
      story.descriptionIsBoilerplate = !cleaned;
      story.descriptionSource = 'listing';
    }

    // card đã có 3 chương mới nhất → đếm ngay, kể cả khi chạy --no-details
    story.chapterCount = story.chapters.length;
    stories.push(story);
  });

  return stories;
}

/* ========================================================================== *
 *  5. PARSER TRANG CHI TIẾT TRUYỆN   /truyen-tranh/<slug>
 * ========================================================================== */

export function parseDetailPage(html: string, cfg: Config, story: Story): void {
  const $ = load(html);
  const $detail = $('#item-detail');

  const title = cleanText($detail.find('h1.title-detail').first().text());
  if (title) story.name = title;

  const id = $detail.find('.follow-url').first().attr('data-id');
  if (id) story.comicId = id;

  // <time class="small"> [Cập nhật lúc: 2026-09-26 20:48:06] </time>
  const timeText = cleanText($detail.find('time.small').first().text());
  const mt =
    timeText.match(/Cập nhật lúc[:\s]*([^\]]+)\]/i) ?? timeText.match(/(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?)/);
  if (mt) story.updatedAtExact = mt[1].trim();

  // ul.list-info: Tác giả · Tình trạng · Thể loại · Lượt xem
  $detail.find('ul.list-info > li').each((_, li) => {
    const $li = $(li);
    const label = normKey(cleanText($li.find('p.name').text()));
    const $value = $li.children('p').last();
    const value = cleanText($value.text());
    if (!label) return;
    if (label.includes('tacgia')) story.author = better(story.author, value);
    else if (label.includes('tinhtrang')) story.status = better(story.status, value);
    else if (label.includes('theloai')) {
      const gs = $value
        .find('a')
        .map((_, a) => cleanText($(a).text()))
        .get()
        .filter(Boolean);
      story.genres = betterList(
        story.genres,
        gs.length ? gs : value.split(/[-,]/).map((g) => g.trim()).filter(Boolean),
      );
    } else if (label.includes('luotxem')) {
      story.views = parseViNumber(value) ?? story.views;
      story.viewsRaw = value || story.viewsRaw;
    } else if (label.includes('yenthich') || label.includes('luotthich')) story.likes = parseViNumber(value) ?? story.likes;
    else if (label.includes('binhluan')) story.comments = parseViNumber(value) ?? story.comments;
  });

  // Xếp hạng (schema.org AggregateRating)
  const $rate = $('span[itemprop="aggregateRating"]').first();
  if ($rate.length) {
    const v = Number($rate.find('span[itemprop="ratingValue"]').text());
    const b = Number($rate.find('span[itemprop="bestRating"]').text());
    story.rating = {
      value: Number.isFinite(v) ? v : null,
      best: Number.isFinite(b) ? b : null,
      count: parseViNumber($rate.find('span[itemprop="ratingCount"]').text()),
    };
  }

  const follow = cleanText($detail.find('.number_follow').first().text());
  if (follow) story.follows = parseViNumber(follow) ?? story.follows;

  // og:title "... [Tới Chap 1295] ..."
  const og = $('meta[property="og:title"]').attr('content') ?? '';
  const mc = og.match(/Tới\s*Chap\s*(\d+(?:\.\d+)?)/i);
  if (mc) story.latestChapterNumberFromTitle = Number(mc[1]);

  // Nút "Đọc từ đầu" / "Đọc mới nhất"
  $detail.find('.read-action a').each((_, a) => {
    const href = abs($(a).attr('href'), cfg.baseUrl);
    if (!href) return;
    const t = cleanText($(a).text());
    const num = chapterNumber(href, null);
    const ref: ChapterRef = { number: num, title: t, url: href };
    if (/từ đầu|dau|đầu$/i.test(t)) {
      // nút "Đọc từ đầu" đáng tin hơn suy đoán từ danh sách 20 chương
      if (!story.firstChapter || story.firstChapter.number === num) story.firstChapter = ref;
    } else if (/nhất|cuối|end/i.test(t)) {
      const betterTitle = story.latestChapter && story.latestChapter.number === num ? story.latestChapter.title : t;
      story.latestChapter = { ...ref, title: betterTitle };
    }
  });

  // Mô tả: .shortened — các div đầu là SEO, phần thật lẫn phía trong → lọc theo dòng
  const $short = $detail.find('.detail-content .shortened').first();
  if ($short.length) {
    const raw = cleanText($short.text());
    const cleaned = stripSeo(raw);
    if (cleaned && (!story.description || story.descriptionIsBoilerplate)) {
      story.description = cleaned;
      story.descriptionIsBoilerplate = false;
      story.descriptionSource = 'detail';
    }
    if (!story.descriptionRaw && raw) story.descriptionRaw = raw;
  }

  // ---- DANH SÁCH CHƯƠNG (#chapter_list) ----
  const map = new Map<string, ChapterInfo>(story.chapters.map((c) => [c.url, c]));
  $detail.find('#chapter_list li').each((_, li) => {
    const $li = $(li);
    const $a = $li.find('a').first();
    const href = abs($a.attr('href'), cfg.baseUrl);
    if (!href) return;
    const cells = $li
      .children('div')
      .map((_, d) => cleanText($(d).text()))
      .get();
    const updatedAtText = cells[1] ?? null;
    const viewsRaw = cells[2] ?? null;
    const title = cleanText($a.text());
    const prev = map.get(href);
    map.set(href, {
      number: chapterNumber(href, title),
      title,
      url: href,
      chapterId: $a.attr('data-id') ?? prev?.chapterId ?? null,
      views: parseViNumber(viewsRaw) ?? prev?.views ?? null,
      viewsRaw: viewsRaw || prev?.viewsRaw || null,
      updatedAtText: updatedAtText || prev?.updatedAtText || null,
      source: 'detail',
      content: prev?.content,
    });
  });

  story.chapters = [...map.values()].sort((a, b) => (b.number ?? -1) - (a.number ?? -1));
  story.chapterCount = story.chapters.length;
  if (!story.latestChapter && story.chapters[0]) {
    const c = story.chapters[0];
    story.latestChapter = { number: c.number, title: c.title, url: c.url };
  }
  if (!story.firstChapter) {
    const last = story.chapters[story.chapters.length - 1];
    if (last) story.firstChapter = { number: last.number, title: last.title, url: last.url };
  }
}

/* ========================================================================== *
 *  6. PARSER TRANG CHƯƠNG   /truyen-tranh/<slug>/chuong-<n>
 *     Ảnh nằm trong:  <div class='page-chapter'><img class='lozad' data-src='…'>
 *     Ảnh "notice" của site (alt='Notice' / /assets/images/) phải bị loại.
 * ========================================================================== */

export function parseChapterPage(html: string, cfg: Config): Omit<ChapterContent, 'fetchedAt'> {
  const $ = load(html);
  const images: string[] = [];
  const pageElements = $("div[class*='page-chapter'], div.page-chapter").length;

  $("div[class*='page-chapter'] img, div.page-chapter img, div.reading img, #divImage img").each((_, el) => {
    const $el = $(el);
    if (/notice/i.test(cleanText($el.attr('alt') ?? ''))) return;
    const src =
      $el.attr('data-src') || $el.attr('data-original') || $el.attr('data-sv1') || $el.attr('src') || '';
    const u = abs(src, cfg.baseUrl);
    if (!u || /\/assets\/images\//.test(u)) return;
    if (!/\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(u)) return;
    if (!images.includes(u)) images.push(u);
  });

  let hosts: string[] = [];
  try {
    hosts = [...new Set(images.map((i) => new URL(i).host))];
  } catch {
    /* URL lạ → bỏ qua */
  }

  return { imageCount: images.length, images, pageElements, imageHosts: hosts, htmlLength: html.length };
}

/* ========================================================================== *
 *  7. SCRAPER (listing → detail → chapter)
 * ========================================================================== */

class NetTruyenScraper {
  private http: Http;
  private stream: fs.WriteStream | null = null;
  private stories: Story[] = [];
  private donePages: number[] = [];
  private failedPages: number[] = [];
  /** slug đã cào (để không trùng lại) — gồm cả dữ liệu resume. */
  private done = new Set<string>();
  private count = 0;
  private t0 = Date.now();
  private currentPage = 0;
  private currentStory = '';
  /** ước lượng tổng số truyện (số trang × 36) để log hiển thị x/y. */
  private expectedStories = 0;

  constructor(private cfg: Config) {
    this.http = new Http(cfg);
  }

  private listingUrl(page: number): string {
    return `${this.cfg.baseUrl}/trang-chu?page=${page}`;
  }

  private log(...a: unknown[]): void {
    if (this.cfg.verbose) console.log(...a);
  }

  /** Cập nhật dòng tiến độ chung của script. */
  private tick(extra: Partial<ProgressInfo> = {}, urgent = false): void {
    progress.tick(
      {
        page: this.currentPage,
        pagesTotal: this.cfg.endPage - this.cfg.startPage + 1,
        pagesDone: this.donePages.length,
        done: this.count,
        total: this.expectedStories,
        story: this.currentStory,
        failed: this.failedPages.length,
        ...extra,
      },
      urgent,
    );
  }

  private loadResume(): void {
    if (!this.cfg.resume || !fs.existsSync(this.cfg.jsonlFile)) return;
    const { stories } = loadStoriesFile(this.cfg.jsonlFile);
    let n = 0;
    for (const o of stories) {
      if (o?.slug && !this.done.has(o.slug)) {
        this.done.add(o.slug);
        this.stories.push(o);
        n++;
      }
    }
    if (n) console.log(`↺ resume: nạp ${n} truyện đã có từ ${this.cfg.jsonlFile}`);
  }

  /** Giai đoạn 2: bù details + chương + ảnh cho catalogue đã có. */
  async enrich(): Promise<Story[]> {
    let list = loadStoriesFile(this.cfg.enrichFrom).stories;
    const total = list.length;
    if (this.cfg.endPage > 0) {
      list = list.filter((s) => (s.listingPage ?? 0) >= this.cfg.startPage && (s.listingPage ?? 0) <= this.cfg.endPage);
    }
    if (this.cfg.storyLimitPerPage > 0) list = list.slice(0, this.cfg.storyLimitPerPage);
    console.log(
      `\n▶ ENRICH ${path.resolve(this.cfg.enrichFrom)}: ${list.length}/${total} truyện` +
        ` · details=${this.cfg.details ? 'on' : 'off'} · chapters=${this.cfg.chapterMode} · limit=${this.cfg.chapterLimit || '∞'}`,
    );

    fs.mkdirSync(path.dirname(path.resolve(this.cfg.jsonlFile)), { recursive: true });
    fs.mkdirSync(path.dirname(path.resolve(this.cfg.outFile)), { recursive: true });
    this.stream = fs.createWriteStream(this.cfg.jsonlFile, { flags: 'w' });
    const t0 = Date.now();
    let i = 0;
    await runPool(list, Math.max(1, Math.ceil(this.cfg.concurrency / 2)), async (story) => {
      await this.scrapeStory(story);
      this.stream?.write(JSON.stringify(story) + '\n');
      i++;
      this.count++;
      this.stories.push(story);
      this.currentStory = story.slug;
      this.expectedStories = list.length;
      this.currentPage = this.cfg.startPage;
      this.tick({ story: story.slug, sub: `(${i}/${list.length}) ✓ ${story.chapterCount} chương · ${story.totalImages} ảnh` }, true);
      if (i % 100 === 0) this.writeJson();
    });
    progress.finish();
    this.writeJson();
    await new Promise<void>((r) => this.stream?.end(r));
    console.log(
      `\n════ ENRICH XONG ════\n  Truyện: ${list.length} · tác giả có: ${
        list.filter((s) => s.author && !/đang cập nhật/i.test(s.author)).length
      } · chương: ${list.reduce((a, s) => a + s.chapterCount, 0)} · chương đã quét ảnh: ${list.reduce(
        (a, s) => a + s.scannedChapterCount,
        0,
      )} · ảnh: ${list.reduce((a, s) => a + s.totalImages, 0)}\n  JSON: ${path.resolve(this.cfg.outFile)}\n  Thời gian: ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
    return list;
  }

  /** Quét 1 truyện: chi tiết + (tuỳ chọn) nội dung từng chương. */
  private async scrapeStory(story: Story): Promise<Story> {
    if (this.cfg.details) {
      try {
        parseDetailPage(await this.http.html(story.url, this.listingUrl(story.listingPage)), this.cfg, story);
      } catch (err) {
        story.detailError = (err as Error).message;
        this.log(`  ! chi tiết lỗi ${story.slug}: ${(err as Error).message}`);
      }
    }

    if (this.cfg.chapterMode !== 'none') {
      let targets: ChapterInfo[] = story.chapters.slice();

      if (this.cfg.chapterMode === 'all') {
        const hi = story.latestChapterNumberFromTitle ?? story.latestChapter?.number ?? targets[0]?.number ?? null;
        const lo = story.firstChapter?.number ?? 1;
        if (hi !== null) {
          const byNum = new Map(targets.map((c) => [c.number, c]));
          const full: ChapterInfo[] = [];
          for (let n = hi; n >= lo; n--) {
            const have = byNum.get(n);
            full.push(
              have ?? {
                number: n,
                title: `Chapter ${n}`,
                url: `${story.url}/chuong-${n}`,
                chapterId: null,
                views: null,
                viewsRaw: null,
                updatedAtText: null,
                source: 'scan',
              },
            );
          }
          targets = full;
        }
      }
      if (this.cfg.chapterLimit > 0) targets = targets.slice(0, this.cfg.chapterLimit);

      const total = targets.length;
      let idx = 0;
      await runPool(targets, this.cfg.concurrency, async (ch) => {
        const myIdx = ++idx;
        // urgent: trong TTY đây chính là dòng người dùng muốn nhìn thấy liên tục
        this.tick({ story: story.slug, sub: `chap ${myIdx}/${total} · ${ch.title}` }, true);
        try {
          const parsed = parseChapterPage(await this.http.html(ch.url, story.url), this.cfg);
          const content: ChapterContent = { ...parsed, fetchedAt: new Date().toISOString() };
          if (this.cfg.saveImages) {
            this.tick({ story: story.slug, sub: `chap ${myIdx}/${total} · đang tải ${parsed.imageCount} ảnh` }, true);
            await this.saveImagesFor(story, ch, content);
          }
          ch.content = content;
          story.scannedChapterCount++;
          story.totalImages += parsed.imageCount;
          this.log(`    · ${story.slug} chap ${ch.number} → ${parsed.imageCount} ảnh`);
        } catch (err) {
          progress.warn(`${story.slug} ${ch.title}: ${(err as Error).message.slice(0, 80)}`);
          ch.content = {
            imageCount: 0,
            images: [],
            pageElements: 0,
            imageHosts: [],
            htmlLength: 0,
            error: (err as Error).message,
            fetchedAt: new Date().toISOString(),
          };
        }
      });
      story.chapterCount = story.chapters.length;
    }

    return story;
  }

  /** Tải toàn bộ ảnh của 1 chương về `<saveImages>/<slug>/chuong-<n>/`. */
  private async saveImagesFor(story: Story, ch: ChapterInfo, content: ChapterContent): Promise<void> {
    const dir = path.join(
      this.cfg.saveImages,
      safeName(story.slug),
      'chuong-' + (ch.number ?? 'x') + '-' + safeName(ch.title),
    );
    content.imageDir = dir;
    content.imageFiles = [];
    content.downloaded = 0;
    content.failedDownloads = 0;
    content.downloadedBytes = 0;

    await runPool(content.images, this.cfg.concurrency, async (u, i) => {
      const ext = (u.match(/\.(jpe?g|png|webp|gif|avif)(\?|$)/i)?.[1] ?? '.jpg').toLowerCase();
      const dest = path.join(dir, String(i).padStart(3, '0') + ext);
      try {
        const bytes = await this.http.download(u, dest, ch.url);
        content.imageFiles!.push(dest);
        content.downloaded!++;
        content.downloadedBytes! += bytes;
        // đếm theo ảnh XỬ LÝ XONG (kể cả lỗi) → bộ đếm luôn tiến, không kẹt ở 0
        this.tick(
          {
            story: safeName(story.slug),
            sub: `chap ${ch.number} · ảnh ${content.downloaded! + content.failedDownloads!}/${content.images.length}` +
              (content.failedDownloads ? ` · lỗi ${content.failedDownloads}` : ''),
          },
          true,
        );
      } catch (err) {
        content.imageFiles!.push(null);
        content.failedDownloads!++;
        this.tick(
          { story: safeName(story.slug), sub: `chap ${ch.number} · ảnh ${content.downloaded! + content.failedDownloads!}/${content.images.length} · lỗi ${content.failedDownloads}` },
          true,
        );
        this.log(`      ! lỗi tải ảnh ${u}: ${(err as Error).message}`);
      }
    });
  }

  private writeJson(interrupted = false): void {
    const payload = {
      meta: {
        generator: 'nettruyen.ts (Arena agent)',
        source: this.cfg.baseUrl,
        listEndpoint: '/trang-chu?page={page}',
        generatedAt: new Date().toISOString(),
        startedAt: new Date(this.t0).toISOString(),
        startPage: this.cfg.startPage,
        endPage: this.cfg.endPage,
        pagesCompleted: this.donePages.length,
        pagesFailed: this.failedPages,
        storyCount: this.stories.length,
        chapterCount: this.stories.reduce((a, s) => a + s.chapterCount, 0),
        chapterContentScanned: this.stories.reduce((a, s) => a + s.scannedChapterCount, 0),
        imageCount: this.stories.reduce((a, s) => a + s.totalImages, 0),
        options: {
          details: this.cfg.details,
          chapterMode: this.cfg.chapterMode,
          chapterLimit: this.cfg.chapterLimit,
          concurrency: this.cfg.concurrency,
          delay: this.cfg.delay,
        },
        interrupted,
        fieldNotes: {
          views: 'lượt xem truyện (số thật; viewsRaw là text gốc dạng 13.871 / 46K)',
          rating: 'xếp hạng: value/best/count (số lượt đánh giá)',
          'chapters[].views': 'lượt xem của riêng chương đó',
          'chapters[].updatedAtText': 'thời gian cập nhật của chương (relative: "29 phút trước")',
          'chapters[].content.imageCount': 'số ảnh trong chương',
          'chapters[].content.images': 'URL đầy đủ các ảnh của chương',
          updatedAtExact: '"Cập nhật lúc: …" lấy từ trang chi tiết truyện',
          note: 'site chỉ liệt kê ~20 chương mới nhất ở trang truyện → dùng --chapters all để lấy toàn bộ',
        },
      },
      stories: this.stories,
    };
    fs.mkdirSync(path.dirname(path.resolve(this.cfg.outFile)), { recursive: true });
    const tmp = this.cfg.outFile + '.tmp';
    // Run lớn (hàng chục nghìn truyện) không pretty-print: vừa chậm vừa phình file
    const indent = this.stories.length > 2000 ? 0 : 2;
    const json = JSON.stringify(payload, null, indent);
    // .gz → nén luôn (run 27k truyện: 67MB → ~8MB)
    if (/\.gz$/i.test(this.cfg.outFile)) fs.writeFileSync(tmp, zlib.gzipSync(json, { level: 6 }));
    else fs.writeFileSync(tmp, json, 'utf8');
    fs.renameSync(tmp, this.cfg.outFile);
  }

  async run(totalHint: number | null): Promise<Story[]> {
    this.loadResume();
    fs.mkdirSync(path.dirname(path.resolve(this.cfg.jsonlFile)), { recursive: true });
    this.stream = fs.createWriteStream(this.cfg.jsonlFile, { flags: this.cfg.resume ? 'a' : 'w' });

    const stop = () => {
      progress.finish();
      console.log('\n⏹ Nhận tín hiệu dừng — ghi file phần đã thu thập...');
      this.writeJson(true);
      this.stream?.end(() => process.exit(130));
      setTimeout(() => process.exit(130), 800);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    console.log(
      `\n▶ Quét trang ${this.cfg.startPage}→${this.cfg.endPage} của ${this.cfg.baseUrl}/trang-chu` +
        (totalHint ? `   (site có tổng cộng ${totalHint} trang)` : ''),
    );
    console.log(
      `  details=${this.cfg.details ? 'on' : 'off'} · chapters=${this.cfg.chapterMode}` +
        ` · chapterLimit=${this.cfg.chapterLimit || '∞'} · concurrency=${this.cfg.concurrency} · delay=${this.cfg.delay}ms`,
    );

    // Ước lượng số request để người dùng biết quy mô (quan trọng khi nhập 762 trang)
    if (!this.cfg.resume || this.done.size === 0) {
      const nPages = this.cfg.endPage - this.cfg.startPage + 1;
      const perStory = this.cfg.details ? 1 : 0;
      const chapPer =
        this.cfg.chapterMode === 'none' ? 0 : this.cfg.chapterLimit > 0 ? this.cfg.chapterLimit : 30;
      const estStories = nPages * (this.cfg.storyLimitPerPage || 36);
      const estReq = nPages + estStories * (perStory + chapPer);
      const perSec = Math.max(0.5, Math.min(this.cfg.concurrency, 1000 / Math.max(1, this.cfg.delay)));
      const mins = (estReq / perSec / 60).toFixed(0);
      console.log(
        `  ≈ ${estStories} truyện · ~${estReq.toLocaleString('en-US')} request · ~${mins} phút (với --concurrency ${this.cfg.concurrency} --delay ${this.cfg.delay}ms)`,
      );
      if (estReq > 150_000)
        console.log(
          '  ⚠ RUN RẤT LỚN. Gợi ý: --no-details (bỏ trang chi tiết), --chapter-limit 3,' +
            ' hoặc chia nhỏ --pages 1-200 · 201-400 ... rồi dùng --resume.',
        );
    }

    for (let page = this.cfg.startPage; page <= this.cfg.endPage; page++) {
      this.currentPage = page;
      progress.status(`đang tải trang danh sách ${page}/${this.cfg.endPage}`);
      this.tick({});
      let html: string;
      try {
        html = await this.http.html(this.listingUrl(page));
      } catch (err) {
        this.failedPages.push(page);
        progress.event(`[${page}/${this.cfg.endPage}] ✗ tải trang thất bại: ${(err as Error).message}`);
        continue;
      }

      let found = parseListingPage(html, this.cfg, page);
      if (!found.length) {
        this.failedPages.push(page);
        progress.event(`[${page}/${this.cfg.endPage}] ⚠ parse ra 0 truyện (markup đổi hoặc bị chặn)`);
        continue;
      }
      if (this.cfg.storyLimitPerPage > 0) found = found.slice(0, this.cfg.storyLimitPerPage);
      const pending = found.filter((s) => !this.done.has(s.slug));

      this.expectedStories += pending.length;
      progress.print(
        `[${String(page).padStart(4)}/${this.cfg.endPage}] ${found.length} truyện · ${pending.length} cần cào` +
          (this.cfg.details ? ' · vào từng trang truyện' : ''),
      );

      let i = 0;
      for (const s of pending) {
        this.done.add(s.slug);
        this.currentStory = s.slug;
        this.tick({ story: s.slug, sub: `(${++i}/${pending.length}) đang cào…` }, true);
        await this.scrapeStory(s);
        this.stories.push(s);
        this.count++;
        this.stream?.write(JSON.stringify(s) + '\n');
        this.tick({ sub: `(${i}/${pending.length}) ✓ ${s.chapters.length} chương · ${s.totalImages} ảnh` }, true);
      }
      this.currentStory = '';

      this.donePages.push(page);
      this.tick({}, true);
      // checkpoint thưa dần theo quy mô run (tránh ghi lại file khổng lồ quá nhiều lần)
      const every = Math.max(10, Math.round((this.cfg.endPage - this.cfg.startPage + 1) * 0.02));
      if (this.donePages.length % every === 0) this.writeJson();
    }

    progress.finish();
    this.writeJson();
    await new Promise<void>((r) => this.stream?.end(r));

    const secs = ((Date.now() - this.t0) / 1000).toFixed(1);
    console.log(
      '\n════════ KẾT QUẢ ════════\n' +
        `  Truyện              : ${this.stories.length}\n` +
        `  Số chương           : ${this.stories.reduce((a, s) => a + s.chapterCount, 0)}\n` +
        `  Chương đã quét ảnh  : ${this.stories.reduce((a, s) => a + s.scannedChapterCount, 0)}\n` +
        `  Tổng số ảnh         : ${this.stories.reduce((a, s) => a + s.totalImages, 0)}\n` +
        (this.cfg.saveImages
          ? `  Ảnh đã tải về       : ${downloadedCount(this.stories)} file · ${mb(downloadedBytes(this.stories))} → ${path.resolve(this.cfg.saveImages)}\n`
          : '') +
        `  Trang lỗi           : ${this.failedPages.length}${this.failedPages.length ? ' → ' + this.failedPages.slice(0, 25).join(', ') : ''}\n` +
        `  JSON                : ${path.resolve(this.cfg.outFile)}\n` +
        `  JSONL (chạy dần)    : ${path.resolve(this.cfg.jsonlFile)}\n` +
        `  Thời gian           : ${secs}s`,
    );
    if (this.http.blockedHits > 0)
      console.log(
        `⚠ ${this.http.blockedHits} request bị chặn/quá tải → nên tăng --delay (VD 400) hoặc giảm --concurrency (VD 2).`,
      );
    if (progress.warnings) console.log(`  (đã in ${progress.warnings} cảnh báo trong lúc chạy)`);
    return this.stories;
  }
}


/* ========================================================================== *
 *  8. REPORT — thống kê / CSV / Markdown từ file JSON đã thu thập
 *     (gộp vào cùng file để chỉ cần ĐÚNG MỘT file .ts)
 * ========================================================================== */

export function loadStoriesFile(source: string): { stories: Story[]; meta: Record<string, unknown> } {
  let raw: string;
  if (source === '-') raw = fs.readFileSync(0, 'utf8');
  else if (/\.gz$/i.test(source)) raw = zlib.gunzipSync(fs.readFileSync(source)).toString('utf8');
  else raw = fs.readFileSync(source, 'utf8');
  const txt = raw.trim();
  if (!txt) return { stories: [], meta: {} };
  if (txt.startsWith('{') && txt.includes('"stories"')) {
    const o = JSON.parse(txt) as { stories?: Story[]; meta?: Record<string, unknown> };
    return { stories: o.stories ?? [], meta: o.meta ?? {} };
  }
  // JSONL (có thể cả file JSON bị cắt giữa chừng khi Ctrl+C → bỏ dòng cuối hỏng)
  const stories: Story[] = [];
  let meta: Record<string, unknown> = {};
  for (const line of txt.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    try {
      const o = JSON.parse(l);
      if (o?.stories) {
        stories.push(...(o.stories as Story[]));
        meta = (o.meta as Record<string, unknown>) ?? meta;
      } else if (o?.slug) stories.push(o as Story);
    } catch {
      /* dòng hỏng → bỏ qua (resume/kill giữa chừng) */
    }
  }
  return { stories, meta };
}

export interface Summary {
  storyCount: number;
  withAuthor: number;
  withDescription: number;
  withOtherNames: number;
  statusEmptyInSource: number;
  withRating: number;
  statusCounts: [string, number][];
  genreCounts: [string, number][];
  views: NumStats;
  follows: NumStats;
  comments: NumStats;
  likes: NumStats;
  ratingValue: NumStats;
  chaptersPerStory: NumStats;
  storiesWithChapters: number;
  totalChapters: number;
  chaptersWithViews: number;
  chapterViews: NumStats;
  scannedChapters: number;
  totalImages: number;
  imagesPerChapter: NumStats;
  downloadedImages: number;
  downloadedMB: number;
  topByViews: { name: string; views: number; status: string; chapters: number; author: string }[];
}

export interface NumStats {
  min: number;
  max: number;
  avg: number;
  median: number;
  p90: number;
  sum: number;
  n: number;
}

export function stats(values: (number | null | undefined)[], round = 1): NumStats {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { min: 0, max: 0, avg: 0, median: 0, p90: 0, sum: 0, n: 0 };
  const sum = v.reduce((a, b) => a + b, 0);
  const r = (x: number) => Number(x.toFixed(round));
  /** phân vị nội suy tuyến tính (type 7 — giống R/numpy default) */
  const quantile = (q: number) => {
    if (v.length === 1) return v[0];
    const pos = (v.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.min(v.length - 1, lo + 1);
    return v[lo] + (v[hi] - v[lo]) * (pos - lo);
  };
  return {
    min: v[0],
    max: v[v.length - 1],
    avg: r(sum / v.length),
    median: r(quantile(0.5)),
    p90: r(quantile(0.9)),
    sum: r(sum),
    n: v.length,
  };
}

/** Gộp các biến thể hoa/thường + đồng nghĩa mà site dùng cho "Tình trạng". */
export function normalizeStatus(v: string | null | undefined): string {
  const k = (v ?? '')
    .trim()
    .toLowerCase()
    .replace(/đ/g, 'd') // NFD không tách được 'đ' → phải thay thủ công
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
  if (!k) return 'Không rõ';
  if (/^(da )?(hoan thanh|tap cuoi|end|ket thuc)$/.test(k) || /\b(done|full|complete|completed)\b/.test(k)) return 'Hoàn thành';
  if (/^(tam ngung|tam dung|ngung|hiatus|drop|dang dung)/.test(k)) return 'Tạm ngưng';
  if (/(loading|ongoing|dang tien hanh|dang cap nhat|dang ra|dang dien ra|dang xuat ban|dang tiep tuc|tiep tuc|phat hanh)/.test(k))
    return 'Đang tiến hành';
  return (v ?? '').trim().replace(/^\p{L}/u, (c) => c.toUpperCase());
}

function tally(values: (string | null | undefined)[]): [string, number][] {
  const m = new Map<string, number>();
  for (const v of values) {
    const k = (v ?? '').trim();
    if (!k) continue;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

export function summarize(stories: Story[]): Summary {
  const allChapters: ChapterInfo[] = stories.flatMap((s) => s.chapters ?? []);
  const scanned = allChapters.filter((c) => c.content && !c.content.error);

  const genreCounts = tally(stories.flatMap((s) => s.genres ?? []).map((g) => (g || '').trim())).filter(
    (g) => !/^(khác|đang cập nhật)$/i.test(g[0]),
  );

  return {
    storyCount: stories.length,
    withAuthor: stories.filter((s) => s.author && !/đang cập nhật/i.test(s.author)).length,
    withDescription: stories.filter((s) => s.description && !s.descriptionIsBoilerplate).length,
    withOtherNames: stories.filter((s) => (s.otherNames ?? '').trim().length > 0).length,
    statusEmptyInSource: stories.filter((s) => !(s.status ?? '').trim()).length,
    withRating: stories.filter((s) => s.rating?.count).length,
    statusCounts: tally(stories.map((s) => normalizeStatus(s.status))),
    genreCounts,
    views: stats(stories.map((s) => s.views)),
    follows: stats(stories.map((s) => s.follows)),
    comments: stats(stories.map((s) => s.comments)),
    likes: stats(stories.map((s) => s.likes)),
    ratingValue: stats(stories.map((s) => s.rating?.value)),
    chaptersPerStory: stats(stories.map((s) => s.chapters?.length ?? 0), 2),
    storiesWithChapters: stories.filter((s) => (s.chapters?.length ?? 0) > 0).length,
    totalChapters: allChapters.length,
    chaptersWithViews: allChapters.filter((c) => typeof c.views === 'number').length,
    chapterViews: stats(allChapters.map((c) => c.views)),
    scannedChapters: scanned.length,
    totalImages: scanned.reduce((a, c) => a + (c.content?.imageCount ?? 0), 0),
    imagesPerChapter: stats(scanned.map((c) => c.content?.imageCount), 2),
    downloadedImages: scanned.reduce((a, c) => a + (c.content?.downloaded ?? 0), 0),
    downloadedMB: Number(
      (scanned.reduce((a, c) => a + (c.content?.downloadedBytes ?? 0), 0) / 1024 / 1024).toFixed(1),
    ),
    topByViews: [...stories]
      .sort((a, b) => (b.views ?? 0) - (a.views ?? 0))
      .slice(0, 1000)
      .map((s) => ({
        name: s.name,
        views: s.views ?? 0,
        status: s.status ?? '',
        chapters: s.chapters?.length ?? 0,
        author: s.author ?? 'Đang cập nhật',
      })),
  };
}

/* ------------------------------------------------------------------ xuất báo cáo */


/** Định dạng số theo kiểu Việt Nam: 5000000 → 5.000.000 */
export function fmtNum(n: number): string {
  return n.toLocaleString('vi-VN');
}


/** Tỉ lệ % làm tròn 1 chữ số, ví dụ 12.3% */
export function fmtPct(part: number, total: number): string {
  return total ? ((part / total) * 100).toFixed(1) + '%' : '0%';
}

export function toMarkdown(s: Summary, meta: Record<string, unknown>, top: number): string {
  const L: string[] = [];
  L.push('# Báo cáo dữ liệu NetTruyen', '');
  const opts = (meta?.options ?? {}) as { details?: boolean; chapterMode?: string; chapterLimit?: number };
  if (opts.details === false)
    L.push(
      '> ⚠ Run này dùng `--no-details`: chỉ lấy dữ liệu ở **trang danh sách** →' +
        ' `author` / `rating` / ngày cập nhật tuyệt đối **không được quét**, mỗi truyện chỉ có tối đa 3 chương (card),' +
        ' và `views` là số **rút gọn** từ card ("14K" → 14000) nên sai số có thể tới ±50%.' +
        ' Chạy lại bỏ cờ `--no-details` để lấy số chính xác.',
      '',
    );
  else if (opts.chapterMode === 'listed' && opts.chapterLimit)
    L.push(
      `> Mỗi truyện chỉ có tối đa **${opts.chapterLimit} chương** được quét nội dung` +
        ' (site chỉ liệt kê ~20 chương mới nhất ở trang truyện) → dùng `--chapters all` nếu cần toàn bộ.',
      '',
    );
  if (meta?.generatedAt) L.push(`- Nguồn: \`${meta.source ?? '?'}\` · sinh lúc ${meta.generatedAt}`);
  if (meta?.startPage !== undefined && Number(meta.pagesCompleted ?? 0) > 0)
    L.push(`- Phạm vi trang danh sách: ${meta.startPage} → ${meta.endPage} (đã xong ${fmtNum(Number(meta.pagesCompleted))} trang)`);
  else if (meta?.chapterMode === undefined && meta?.source) L.push('- Nguồn: file được tạo ở chế độ enrich (bù dữ liệu chi tiết).');
  L.push(`- Tổng số truyện: **${fmtNum(s.storyCount)}**`, '');

  L.push('## Độ phủ dữ liệu', '', '| Trường | Có dữ liệu | Tỉ lệ |', '|---|---:|---:|');
  L.push(`| Tác giả (không phải "Đang cập nhật") | ${fmtNum(s.withAuthor)} | ${fmtPct(s.withAuthor, s.storyCount)} |`);
  L.push(`| Mô tả thật (không boilerplate SEO) | ${fmtNum(s.withDescription)} | ${fmtPct(s.withDescription, s.storyCount)} |`);
  L.push(`| Có lượt đánh giá (xếp hạng) | ${fmtNum(s.withRating)} | ${fmtPct(s.withRating, s.storyCount)} |`);
  L.push(`| Có danh sách chương | ${fmtNum(s.storiesWithChapters)} | ${fmtPct(s.storiesWithChapters, s.storyCount)} |`);
  L.push(`| Có "tên khác" (alias) | ${fmtNum(s.withOtherNames)} | ${fmtPct(s.withOtherNames, s.storyCount)} |`, '');

  const row = (name: string, v: NumStats) =>
    `| ${name} | ${fmtNum(v.min)} | ${fmtNum(v.median)} | ${fmtNum(v.avg)} | ${fmtNum(v.p90)} | ${fmtNum(v.max)} | ${fmtNum(v.sum)} |`;
  L.push('## Phân bố theo truyện', '', '| Chỉ số | min | median | trung bình | p90 | max | tổng |', '|---|---:|---:|---:|---:|---:|---:|');
  L.push(row('Lượt xem', s.views));
  L.push(row('Theo dõi', s.follows));
  L.push(row('Bình luận', s.comments));
  L.push(row('Thích/tim', s.likes));
  L.push(row('Số chương (hiện trong JSON)', s.chaptersPerStory));
  if (s.ratingValue.n) L.push(row('Điểm xếp hạng /5', s.ratingValue));
  L.push('');

  L.push('## Tình trạng truyện', '', '| Tình trạng | Số truyện | Tỉ lệ |', '|---|---:|---:|');
  for (const [k, v] of s.statusCounts) L.push(`| ${k} | ${fmtNum(v)} | ${fmtPct(v, s.storyCount)} |`);

  L.push('', '## Thể loại (top 25)', '', '| Thể loại | Số truyện |', '|---|---:|');
  for (const [g, n] of s.genreCounts.slice(0, 25)) L.push(`| ${g} | ${fmtNum(n)} |`);

  L.push('', '## Chương & ảnh', '');
  L.push(`- Tổng số chương trong JSON: **${fmtNum(s.totalChapters)}** (có lượt xem theo chương: ${fmtNum(s.chaptersWithViews)})`);
  L.push(`- Lượt xem mỗi chương: min ${fmtNum(s.chapterViews.min)} · median ${fmtNum(s.chapterViews.median)} · trung bình ${fmtNum(s.chapterViews.avg)} · max ${fmtNum(s.chapterViews.max)}`);
  L.push(`- Chương đã quét nội dung (ảnh): **${fmtNum(s.scannedChapters)}** · tổng ảnh: **${fmtNum(s.totalImages)}**`);
  if (s.scannedChapters)
    L.push(`- Số ảnh / chương: min ${fmtNum(s.imagesPerChapter.min)} · median ${fmtNum(s.imagesPerChapter.median)} · trung bình ${s.imagesPerChapter.avg} · max ${fmtNum(s.imagesPerChapter.max)}`);
  if (s.downloadedImages) L.push(`- Ảnh đã tải về máy: ${fmtNum(s.downloadedImages)} file · ${s.downloadedMB} MB`);

  if (s.likes.sum && s.likes.sum === s.follows.sum)
    L.push('', '> ℹ Trên site này icon ❤ ở card danh sách **chính là số Theo dõi** (đã đối chiếu 100% số truyện) → `likes` trùng `follows`, không phải chỉ số riêng.', '');
  if (s.comments.max > 1_000_000)
    L.push(
      `> ⚠ Lượt bình luận của site bị thổi phồng (max ${fmtNum(s.comments.max)} — ví dụ One Piece ghi 201,764,145` +
        ' comment). Đây đúng là số site hiển thị, không phải lỗi parse; cân nhắc lọc khi phân tích.',
      '',
    );

  L.push('', `## Top ${Math.min(top, s.topByViews.length)} truyện nhiều lượt xem nhất`, '');
  L.push('| # | Truyện | Lượt xem | Chương | Tình trạng | Tác giả |', '|---:|---|---:|---:|---|---|');
  s.topByViews.slice(0, top).forEach((t, i) => {
    L.push(`| ${i + 1} | ${t.name.replace(/\|/g, '\\|')} | ${fmtNum(t.views)} | ${t.chapters} | ${t.status} | ${t.author.replace(/\|/g, '\\|')} |`);
  });
  L.push('');
  return L.join('\n');
}

/** CSV: mỗi truyện 1 dòng (flatten), kèm tổng hợp chương/ảnh. */
export function toCsv(stories: Story[]): string {
  const cols = [
    'listingPage', 'name', 'otherNames', 'author', 'genres', 'status', 'views', 'viewsRaw',
    'rating', 'ratingCount', 'follows', 'comments', 'likes', 'updatedAtRelative', 'updatedAtExact',
    'chapterCount', 'firstChapter', 'latestChapter', 'latestChapterNumber', 'scannedChapters',
    'totalImages', 'url', 'slug', 'description',
  ];
  const esc = (v: unknown) => {
    const s2 = Array.isArray(v) ? v.join(' | ') : v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s2) ? '"' + s2.replace(/"/g, '""') + '"' : s2;
  };
  const lines = [cols.join(',')];
  for (const s of stories) {
    lines.push(
      [
        s.listingPage, s.name, s.otherNames, s.author, s.genres, s.status, s.views, s.viewsRaw,
        s.rating?.value, s.rating?.count, s.follows, s.comments, s.likes, s.updatedAtRelative, s.updatedAtExact,
        s.chapters?.length ?? 0,
        s.firstChapter ? `${s.firstChapter.title} (${s.firstChapter.url})` : '',
        s.latestChapter ? `${s.latestChapter.title} (${s.latestChapter.url})` : '',
        s.latestChapterNumberFromTitle, s.scannedChapterCount ?? 0, s.totalImages ?? 0,
        s.url, s.slug, (s.description ?? '').replace(/\n+/g, ' '),
      ]
        .map(esc)
        .join(','),
    );
  }
  return lines.join('\n') + '\n';
}

/* ========================================================================== *
 *  9. PROMPT + MAIN
 * ========================================================================== */

/** Hỏi người dùng số trang; trả về số trang hợp lệ. */
async function askPageCount(cfg: Config, total: number | null): Promise<number> {
  const isTTY = process.stdin.isTTY === true;
  if (!isTTY) {
    console.log(`? stdin không phải TTY → ${total ? `dùng hết ${total} trang` : 'dùng 1 trang'}. (hoặc truyền --pages N)`);
    return total && total > 0 ? total : 1;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let answer: number | null = null;
  while (answer === null) {
    const raw = (await rl.question(`\nNhập SỐ TRANG muốn thu thập (1 → ${total ?? '?'}, Enter = ${total ?? 1}): `)).trim();
    if (raw === '') {
      answer = total && total > 0 ? total : 1;
      break;
    }
    if (!/^\d+$/.test(raw)) {
      console.log('  ✗ Nhập vào một số nguyên dương, ví dụ: 762');
      continue;
    }
    const n = Number(raw);
    if (n < 1) {
      console.log('  ✗ Phải lớn hơn hoặc bằng 1.');
      continue;
    }
    if (total && n > total) {
      console.log(`  ! Site chỉ có ${total} trang → mình sẽ giới hạn lại thành ${total}.`);
      return total;
    }
    answer = n;
  }
  rl.close();
  return answer;
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.help) {
    console.log(HELP);
    return;
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const cfg: Config = {
    ...DEFAULTS,
    ...cli,
    outFile: cli.outFile || path.join('data', `nettruyen-${stamp}.json`),
    jsonlFile: cli.jsonlFile || path.join('data', `nettruyen-${stamp}.jsonl`),
  };

  if (cfg.reportFrom) {
    await runReport(cfg);
    return;
  }

  console.log('NETTRUYEN.GG — Story & Chapter Scraper (1 file duy nhất)');
  console.log('═'.repeat(58));

  progress.configure({
    mode: cfg.progressMode,
    everyN: cfg.verbose ? 1 : cfg.progressEvery,
    everyMs: cfg.verbose ? 1 : cfg.progressEveryMs,
  });
  if (cfg.quiet) progress.mute();

  const http = new Http(cfg);

  // phát hiện tổng số trang ngay từ trang 1 (để validate + hiển thị cho user)
  let total: number | null = null;
  if (cfg.enrichFrom) {
    await new NetTruyenScraper(cfg).enrich();
    return;
  }
  try {
    total = detectTotalPages(load(await http.html(`${cfg.baseUrl}/trang-chu?page=${cfg.startPage}`)));
    console.log(`ℹ Trang danh sách có ${total ?? '?'} trang (~${(total ?? 0) * 36} truyện).`);
  } catch (err) {
    console.log(`! Không kiểm tra được tổng số trang: ${(err as Error).message}`);
  }

  if (!cfg.endPage || cfg.endPage < 1) cfg.endPage = await askPageCount(cfg, total);
  else {
    console.log(`\n▶ Số trang user chọn qua --pages: ${cfg.startPage}..${cfg.endPage}`);
    if (total && cfg.endPage > total) console.log(`  (site chỉ có ${total} trang — trang vượt sẽ trả về rỗng)`);
  }
  if (cfg.startPage < 1) cfg.startPage = 1;
  if (cfg.endPage < cfg.startPage) {
    console.error(`✗ endPage (${cfg.endPage}) < startPage (${cfg.startPage})`);
    process.exit(2);
  }
  if (cfg.chapterMode === 'all' && !cfg.chapterLimit)
    console.log('! --chapters all + --chapter-limit 0 = crawl TOÀN BỘ chương → cực nhiều request, có thể bị chặn IP.');

  if (cfg.enrichFrom) {
    if (!fs.existsSync(cfg.enrichFrom)) {
      console.error(`✗ Không tìm thấy file enrich: ${cfg.enrichFrom}`);
      process.exit(2);
    }
    if (!cfg.endPage) cfg.endPage = 0; // 0 = không lọc theo trang danh sách
    await new NetTruyenScraper(cfg).enrich();
    return;
  }

  await new NetTruyenScraper(cfg).run(total);
}

/* -------------------------------- CLI args -------------------------------- */

interface ParsedArgs extends Partial<Config> {
  help?: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  const num = (v: string | undefined, fb: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fb;
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token) continue;
    if (!token.startsWith('-')) continue;

    const body = token.replace(/^--?/, '');
    const eq = body.indexOf('=');
    const name = (eq >= 0 ? body.slice(0, eq) : body).toLowerCase();
    let value: string | undefined = eq >= 0 ? body.slice(eq + 1) : undefined;
    const flag = ['help', 'h', 'resume', 'verbose', 'v', 'no-details', 'list-only', 'quiet', 'q'].includes(name);
    if (!flag) {
      if (value === undefined) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          value = next;
          i++;
        }
      }
    }
    const v = value ?? '';

    switch (name) {
      case 'help':
      case 'h':
        out.help = true;
        break;
      case 'pages': {
        const m = v.match(/^(\d+)\s*(?:-\s*(\d+))?$/);
        if (!m) console.log(`! --pages mong đợi số (VD: 762 hoặc 10-20), nhận được: "${v}"`);
        else if (m[2]) {
          out.startPage = Number(m[1]);
          out.endPage = Number(m[2]);
        } else out.endPage = Number(m[1]);
        break;
      }
      case 'from':
      case 'start-page':
        out.startPage = num(v, 1);
        break;
      case 'to':
      case 'end-page':
        out.endPage = num(v, 0);
        break;
      case 'out':
      case 'output':
        if (v) out.outFile = v;
        break;
      case 'jsonl':
        if (v) out.jsonlFile = v;
        break;
      case 'resume':
        out.resume = true;
        break;
      case 'no-details':
      case 'list-only':
        out.details = false;
        out.chapterMode = 'none';
        break;
      case 'chapters':
      case 'chapter-mode': {
        const s = v.toLowerCase();
        if (s === 'none' || s === 'listed' || s === 'all') out.chapterMode = s;
        else if (s === 'full') out.chapterMode = 'all';
        else console.log(`! --chapters nhận none|listed|all, bỏ qua "${v}"`);
        break;
      }
      case 'chapter-limit':
        out.chapterLimit = Math.max(0, num(v, 0));
        break;
      case 'limit':
        out.storyLimitPerPage = Math.max(0, num(v, 0));
        break;
      case 'enrich':
        out.enrichFrom = v;
        break;
      case 'report':
        out.reportFrom = v || '-';
        break;
      case 'csv':
        out.csvFile = v;
        break;
      case 'md':
      case 'markdown':
        out.mdFile = v;
        break;
      case 'top':
        out.reportTop = Math.max(1, num(v, 10));
        break;
      case 'save-images':
      case 'images-dir':
        out.saveImages = v || 'images';
        break;
      case 'concurrency':
      case 'c':
        out.concurrency = Math.max(1, num(v, DEFAULTS.concurrency));
        break;
      case 'delay':
        out.delay = Math.max(0, num(v, DEFAULTS.delay));
        break;
      case 'timeout':
        out.timeout = Math.max(1000, num(v, DEFAULTS.timeout));
        break;
      case 'retries':
        out.retries = Math.max(0, num(v, DEFAULTS.retries));
        break;
      case 'ua':
      case 'user-agent':
        if (v) out.userAgent = v;
        break;
      case 'base':
        if (v) out.baseUrl = v.replace(/\/+$/, '');
        break;
      case 'verbose':
      case 'v':
        out.verbose = true;
        break;
      case 'progress': {
        const p = v.toLowerCase();
        if (p === 'auto' || p === 'tty' || p === 'always' || p === 'never') out.progressMode = p;
        else if (p === 'line' || p === 'file') out.progressMode = 'always';
        else console.log(`! --progress nhận auto|tty|always|never, bỏ qua "${v}"`);
        break;
      }
      case 'progress-every':
        out.progressEvery = Math.max(1, num(v, 5));
        break;
      case 'progress-ms':
        out.progressEveryMs = Math.max(500, num(v, 8000));
        break;
      case 'quiet':
      case 'q':
        out.quiet = true;
        break;
      default:
        console.log(`! Không nhận tham số: ${token}  (--help để xem danh sách)`);
    }
  }
  return out;
}

/** In báo cáo thống kê (+ tuỳ chọn ghi .md / .csv) từ file JSON/JSONL đã thu thập. */
async function runReport(cfg: Config): Promise<void> {
  const file = cfg.reportFrom === '-' ? '-' : path.resolve(cfg.reportFrom);
  if (file !== '-' && !fs.existsSync(file)) {
    console.error(`✗ Không tìm thấy file: ${file}`);
    process.exit(2);
  }
  const { stories, meta } = loadStoriesFile(file);
  if (!stories.length) {
    console.error('✗ Không đọc được truyện nào từ', cfg.reportFrom);
    process.exit(1);
  }
  const sum = summarize(stories);
  const md = toMarkdown(sum, meta, cfg.reportTop);
  console.log(md);
  if (cfg.mdFile) {
    fs.mkdirSync(path.dirname(path.resolve(cfg.mdFile)), { recursive: true });
    fs.writeFileSync(cfg.mdFile, md, 'utf8');
    console.log(`→ đã ghi ${cfg.mdFile}`);
  }
  if (cfg.csvFile) {
    fs.mkdirSync(path.dirname(path.resolve(cfg.csvFile)), { recursive: true });
    fs.writeFileSync(cfg.csvFile, '\uFEFF' + toCsv(stories), 'utf8'); // BOM để Excel mở đúng tiếng Việt
    console.log(`→ đã ghi ${cfg.csvFile} (${stories.length} dòng)`);
  }
}

/* Chạy main() khi thực thi trực tiếp; khi được `import` (test) thì chỉ export. */
const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  main().catch((err) => {
    console.error('\n✗ Lỗi:', err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
}
