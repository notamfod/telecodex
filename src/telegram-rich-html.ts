import {
  tokenizeTelegramRichHtml,
  type TelegramRichParsedTag,
} from "./telegram-rich-tokens.js";

interface OpenTag {
  readonly tag: string;
  readonly allowed: boolean;
  readonly contentStart: number;
  hasSummary: boolean;
}

const SAFE_AUTOLINK = /^<(?:https?|tg|mailto):[^\u0000-\u0020<>\u007f]+>$/i;
const VOID_TAGS = new Set(["hr", "br", "img", "input", "tg-map"]);
const SELF_CLOSING_TAGS = new Set([...VOID_TAGS, "video", "audio"]);
const CONTAINER_TAGS = new Set([
  "blockquote", "aside", "figure", "tg-collage", "tg-slideshow", "table", "ul", "ol",
  "pre", "footer", "details",
]);
const NON_NESTING_TAGS = new Set(["summary", "cite", "figcaption"]);
const STRUCTURAL_TEXT_PARENTS = new Set(["ul", "ol", "table", "tr"]);
const BLOCK_TAGS = new Set([
  ...CONTAINER_TAGS, "h1", "h2", "h3", "h4", "h5", "h6", "p", "hr", "li", "img",
  "video", "audio", "tg-map", "tr", "tg-math-block",
]);
const ALLOWED_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  a: new Set(["href", "name"]),
  code: new Set(["class"]),
  ol: new Set(["start", "type", "reversed"]),
  li: new Set(["value", "type"]),
  input: new Set(["type", "checked"]),
  img: new Set(["src", "alt", "tg-spoiler"]),
  video: new Set(["src", "tg-spoiler"]),
  audio: new Set(["src"]),
  "tg-map": new Set(["lat", "long", "zoom", "width", "height"]),
  table: new Set(["bordered", "striped"]),
  th: new Set(["colspan", "rowspan", "align", "valign"]),
  td: new Set(["colspan", "rowspan", "align", "valign"]),
  details: new Set(["open"]),
  "tg-reference": new Set(["name"]),
  "tg-emoji": new Set(["emoji-id"]),
  "tg-time": new Set(["unix", "format"]),
};
const ALLOWED_TAGS = new Set((
  "a b strong i em u ins s strike del code mark sub sup tg-spoiler tg-reference tg-emoji tg-time tg-math " +
  "h1 h2 h3 h4 h5 h6 p pre footer hr ul ol li input blockquote aside cite br img video audio figure " +
  "figcaption tg-map tg-collage tg-slideshow table tr th td caption details summary tg-math-block"
).split(" "));
const INLINE_TAGS = new Set((
  "a b strong i em u ins s strike del code mark sub sup tg-spoiler tg-reference tg-emoji tg-time tg-math br"
).split(" "));
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

export function sanitizeTelegramRichHtml(
  source: string,
  neutralize: (raw: string) => string,
): [markdown: string, valid: boolean] {
  let output = "";
  let valid = true;
  const stack: OpenTag[] = [];
  for (const token of tokenizeTelegramRichHtml(source)) {
    if (token.kind === "text") {
      const value = token.value;
      const parent = stack.at(-1);
      if (parent?.allowed && STRUCTURAL_TEXT_PARENTS.has(parent.tag) && value.trim()) valid = false;
      output += value;
      continue;
    }

    const raw = token.raw;
    if (!token.complete) {
      output += raw.replace(/</g, "&lt;");
      continue;
    }
    if (SAFE_AUTOLINK.test(raw)) {
      output += raw;
      continue;
    }
    const parsed = token.parsed;
    if (!parsed) {
      output += neutralize(raw);
      continue;
    }
    if (parsed.closing) {
      const top = stack.at(-1);
      const allowed = top?.tag === parsed.tag && top.allowed;
      if (top?.tag === parsed.tag) {
        stack.pop();
        if (allowed && parsed.tag === "details" && !top.hasSummary) valid = false;
        if (allowed && parsed.tag === "tg-emoji" &&
          !singleEmoji(source.slice(top.contentStart, token.start))) valid = false;
      } else if (ALLOWED_TAGS.has(parsed.tag)) {
        valid = false;
      }
      output += allowed ? raw : neutralize(raw);
    } else {
      const parent = stack.at(-1)?.allowed ? stack.at(-1)?.tag : undefined;
      const allowed = validTag(parsed, parent);
      if (!allowed && parent && STRUCTURAL_TEXT_PARENTS.has(parent) && !validParent(parsed.tag, parent)) valid = false;
      if (allowed && parsed.tag === "summary" && stack.at(-1)?.tag === "details") {
        stack.at(-1)!.hasSummary = true;
      }
      output += allowed ? raw : neutralize(raw);
      if (!parsed.selfClosing && !VOID_TAGS.has(parsed.tag)) {
        stack.push({ tag: parsed.tag, allowed, contentStart: token.end, hasSummary: false });
      }
    }
  }
  if (stack.some(({ allowed }) => allowed)) valid = false;
  return [output, valid];
}

export function isTelegramRichTag(tag: string): boolean {
  return ALLOWED_TAGS.has(tag);
}

export function isTelegramRichVoidTag(tag: string): boolean {
  return VOID_TAGS.has(tag);
}

export function isTelegramRichContainerTag(tag: string): boolean {
  return CONTAINER_TAGS.has(tag);
}

export function isTelegramRichNonNestingTag(tag: string): boolean {
  return NON_NESTING_TAGS.has(tag);
}

export function isTelegramRichBlockTag(tag: string): boolean {
  return BLOCK_TAGS.has(tag);
}

export function isTelegramRichSafeUrl(url: string): boolean {
  return /^(?:https?|tg|mailto):[^\u0000-\u0020<>\u007f]*$/i.test(url);
}

export function isTelegramRichSafeMediaUrl(url: string): boolean {
  return /^https?:[^\u0000-\u0020<>\u007f]*$/i.test(url);
}

export function isTelegramRichSafeMarkdownUrl(url: string, image: boolean): boolean {
  return image
    ? isTelegramRichSafeMediaUrl(url) || /^tg:\/\/(?:emoji|time)\?/i.test(url)
    : isTelegramRichSafeUrl(url);
}

function validTag(parsed: TelegramRichParsedTag, parent?: string): boolean {
  const { tag, attributes, selfClosing } = parsed;
  if (!ALLOWED_TAGS.has(tag) || (selfClosing && !SELF_CLOSING_TAGS.has(tag))) return false;
  if (!validParent(tag, parent)) return false;
  if ((tag === "img" || tag === "video" || tag === "audio") && !attributes.has("src")) return false;
  if (tag === "img" && /^tg:\/\/emoji\?/i.test(attributes.get("src") ?? "") &&
    (!attributes.has("alt") || !singleEmoji(attributes.get("alt")!))) return false;
  if (tag === "a" && !attributes.has("href") && !attributes.has("name")) return false;
  if (tag === "input" && attributes.get("type") !== "checkbox") return false;
  if (tag === "tg-map" && (!attributes.has("lat") || !attributes.has("long"))) return false;
  if (tag === "tg-emoji" && !attributes.has("emoji-id")) return false;
  if (tag === "tg-reference" && !attributes.has("name")) return false;
  if (tag === "tg-time" && !attributes.has("unix")) return false;
  if (tag === "code" && attributes.has("class") && parent !== "pre") return false;
  const allowed = ALLOWED_ATTRIBUTES[tag] ?? new Set<string>();
  for (const [name, value] of attributes) {
    if (!allowed.has(name) || !validAttribute(tag, name, value)) return false;
  }
  return true;
}

function validParent(tag: string, parent?: string): boolean {
  if (tag === "summary") return parent === "details";
  if (tag === "li") return parent === "ul" || parent === "ol";
  if (tag === "input") return parent === "li";
  if (tag === "td" || tag === "th") return parent === "tr";
  if (tag === "tr" || tag === "caption") return parent === "table";
  if (tag === "figcaption") return parent === "figure" || parent === "tg-collage" || parent === "tg-slideshow";
  if (tag === "cite") return parent === "aside" || parent === "blockquote" || parent === "figcaption" || parent === "footer";
  if (parent === "ul" || parent === "ol" || parent === "tr" || parent === "table") return false;
  if (parent === "td" || parent === "th") return INLINE_TAGS.has(tag);
  return true;
}

function validAttribute(tag: string, name: string, value?: string): boolean {
  if (name === "href") return Boolean(value && isTelegramRichSafeUrl(value));
  if (name === "src") return Boolean(value && (isTelegramRichSafeMediaUrl(value) ||
    (tag === "img" && /^tg:\/\/emoji\?id=[A-Za-z0-9_.:-]+$/i.test(value))));
  if (name === "name" || name === "emoji-id") return Boolean(value && /^[A-Za-z0-9_.:-]{1,128}$/.test(value));
  if (tag === "code" && name === "class") return Boolean(value && /^language-[A-Za-z0-9_+.-]+$/.test(value));
  if (name === "colspan" || name === "rowspan") return Boolean(value && /^[1-9]\d*$/.test(value));
  if (name === "align") return value === "left" || value === "center" || value === "right";
  if (name === "valign") return value === "top" || value === "middle" || value === "bottom";
  if ((tag === "ol" || tag === "li") && name === "type") return Boolean(value && /^(?:1|a|A|i|I)$/.test(value));
  if ((tag === "ol" && name === "start") || (tag === "li" && name === "value")) return Boolean(value && /^-?\d+$/.test(value));
  if (tag === "tg-time" && name === "unix") return Boolean(value && /^-?\d+$/.test(value));
  if (tag === "tg-time" && name === "format") return Boolean(value);
  if (tag === "tg-map" && ["lat", "long", "zoom", "width", "height"].includes(name)) {
    return Boolean(value && /^-?\d+(?:\.\d+)?$/.test(value));
  }
  if (["checked", "reversed", "tg-spoiler", "bordered", "striped", "open"].includes(name)) {
    return value === undefined;
  }
  return value !== undefined;
}

function singleEmoji(value: string): boolean {
  const segments = [...graphemes.segment(value)];
  return segments.length === 1 &&
    /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]\uFE0F?\u20E3)/u.test(value);
}
