import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { readFile } from "@tauri-apps/plugin-fs";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function up1st(str: string) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export const urlRegex =
  /^(https?:\/\/)(?:\S+(?::\S*)?@)?(?:(?!-)[A-Za-z0-9-]{1,63}(?<!-)\.)+[A-Za-z]{2,}(?::\d{2,5})?(?:\/[^\s]*)?$/;

export function isUrl(str: string): boolean {
  try {
    const url = new URL(str);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// 可选：你可以传入一个更可靠的 domain 提取器（如 tldts）
type DomainExtractor = (hostname: string) => string;

function defaultDomainOf(hostname: string): string {
  // 保留 IP / IPv6 原样
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":"))
    return hostname;

  // 启发式 eTLD+1：最后两段（对 com/net/org 等常见 TLD 基本够用；
  // 多级后缀如 .co.uk 建议传入专业提取器覆盖）
  const parts = hostname.split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  return parts.slice(-2).join(".");
}

// 压缩长参数值：前2 + … + 后1（≤3 不压缩）
const shorten = (s: string) =>
  s.length <= 3 ? s : `${s.slice(0, 2)}…${s.slice(-1)}`;

export function formatUrl(
  url: string,
  opts?: { domainOf?: DomainExtractor } // 可传：({ domainOf: (h) => parse(h).domain! })
) {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    // 尝试补协议再解析
    try {
      parsedUrl = new URL(`https://${url}`);
    } catch {
      return url;
    }
  }

  const domainOf = opts?.domainOf ?? defaultDomainOf;
  const host = domainOf(parsedUrl.hostname);

  // 最后一个路径段
  const pathnameParts = parsedUrl.pathname.split("/").filter(Boolean);
  let lastSegment = "";
  if (pathnameParts.length) {
    const raw = pathnameParts[pathnameParts.length - 1];
    try {
      lastSegment = decodeURIComponent(raw);
    } catch {
      lastSegment = raw;
    }
  }

  // 按出现顺序收集查询参数
  const params: string[] = [];
  parsedUrl.searchParams.forEach((value, key) => {
    // 尝试解码再压缩，失败则原样
    let val = value;
    try {
      val = decodeURIComponent(value);
    } catch {}
    params.push(`${key}=${shorten(val)}`);
  });

  const inside =
    (lastSegment ? lastSegment : "") +
    (lastSegment && params.length ? "|" : "") +
    (params.length ? params.join(",") : "");

  return [host, inside ? `${inside}` : ""];
}

export function host(url: string) {
  const par = formatUrl(url);
  if (typeof par === "string") return par;
  else return par[0];
}

export function inside(url: string) {
  const par = formatUrl(url);
  if (typeof par === "string") return par;
  else return par[1];
}
export function pickRandom<T>(arr: T[]) {
  const index = Math.floor(Math.random() * arr.length);
  return arr[index];
}

export async function fileToBlobUrl(path: string) {
  const bytes = await readFile(path); // Uint8Array
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>]); // 不传 type
  return URL.createObjectURL(blob); // blob: 同源 → 不会被 WebAudio 静音
}
