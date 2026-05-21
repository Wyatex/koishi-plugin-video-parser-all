import { Context, Schema, h, Logger } from 'koishi';
import axios, { AxiosInstance } from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';

export const name = 'video-parser-all';

export const Config = Schema.intersect([
  Schema.object({
    enable: Schema.boolean().default(true).description('是否启用视频解析插件'),
    botName: Schema.string().default('视频解析机器人').description('合并转发消息中显示的机器人名称'),
    showWaitingTip: Schema.boolean().default(true).description('解析时显示等待提示'),
    debug: Schema.boolean().default(false).description('开启调试模式，在控制台输出详细日志'),
  }).description('基础设置'),

  Schema.object({
    unifiedMessageFormat: Schema.string().role('textarea').default(
      `标题：${'标题'}\n作者：${'作者'}\n简介：${'简介'}\n点赞：${'点赞数'}\n收藏：${'收藏数'}\n转发：${'转发数'}\n播放：${'播放数'}\n评论：${'评论数'}\n图片数量：${'图片数量'}`
    ).description('统一消息格式，可用变量：${标题} ${作者} ${简介} ${点赞数} ${收藏数} ${转发数} ${播放数} ${评论数} ${视频时长} ${发布时间} ${图片数量} ${作者ID} ${封面}'),
  }).description('消息格式设置'),

  Schema.object({
    showImageText: Schema.boolean().default(true).description('是否发送解析后的文字内容'),
    showVideoFile: Schema.boolean().default(true).description('是否发送视频文件（关闭则只发送视频链接）'),
    maxDescLength: Schema.number().default(200).description('简介内容最大长度（字符），超出自动截断'),
    videoDownloadTimeout: Schema.number().default(120000).description('视频下载超时（毫秒）'),
    tempDir: Schema.string().default('./temp_videos').description('临时视频存储目录'),
    maxVideoSize: Schema.number().min(0).step(1).default(0).description('最大下载视频大小（MB），0 为不限制大小'),
    forceDownloadVideo: Schema.boolean().default(true).description('强制下载视频后发送（解决B站、小红书等平台URL无法直接发送的问题）'),
  }).description('内容显示设置'),

  Schema.object({
    timeout: Schema.number().min(0).default(180000).description('API 请求超时（毫秒）'),
    videoSendTimeout: Schema.number().min(0).default(60000).description('视频消息发送超时（毫秒，0 为不限制）'),
    userAgent: Schema.string().default('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36').description('API 请求 UA'),
  }).description('网络与 API 设置'),

  Schema.object({
    ignoreSendError: Schema.boolean().default(true).description('忽略消息发送失败，避免插件崩溃'),
    retryTimes: Schema.number().min(0).default(3).description('API 请求及消息发送失败时的重试次数'),
    retryInterval: Schema.number().min(0).default(1000).description('重试间隔（毫秒，同时用于消息发送重试）'),
  }).description('错误与重试设置'),

  Schema.object({
    enableForward: Schema.boolean().default(false).description('启用合并转发（仅 OneBot 平台），视频会单独发送'),
  }).description('发送方式设置'),

  Schema.object({
    waitingTipText: Schema.string().default('正在解析视频，请稍候...').description('解析等待提示'),
    unsupportedPlatformText: Schema.string().default('不支持该平台链接').description('不支持的平台提示'),
    invalidLinkText: Schema.string().default('无效的视频链接').description('无效链接提示（parse 指令）'),
    parseErrorPrefix: Schema.string().default('❌ 解析失败：').description('解析失败消息前缀'),
    parseErrorItemFormat: Schema.string().default('【${url}】: ${msg}').description('每条解析失败格式，可用 ${url}（链接）和 ${msg}（错误信息）'),
  }).description('界面文字设置'),
]);

interface VideoQuality {
  quality: string;
  url: string;
  bit_rate?: number;
}

interface ParsedData {
  type: string;
  title: string;
  desc: string;
  author: string;
  uid: string;
  avatar: string;
  cover: string;
  video: string;
  videos: VideoQuality[];
  images: string[];
  live_photo: Array<{ image: string; video: string }>;
  music: { title?: string; author?: string; cover?: string; url?: string };
  like: number;
  comment: number;
  collect: number;
  share: number;
  play: number;
  duration: number;
  publishTime: number;
}

const logger = new Logger(name);
let debugEnabled = false;

function debugLog(level: string, ...args: any[]) {
  if (!debugEnabled) return;
  const timestamp = new Date().toISOString();
  const message = `[${timestamp}] [${level}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ')}`;
  logger.info(message);
}

interface LinkMatch {
  type: string;
  url: string;
  id: string;
}

function linkTypeParser(content: string): LinkMatch[] {
  content = content.replace(/\\\//g, '/');
  const rules: { pattern: RegExp; type: string; buildUrl: (id: string) => string }[] = [
    { pattern: /bilibili\.com\/video\/([ab]v[0-9a-zA-Z]+)/gi, type: 'bilibili', buildUrl: (id) => `https://www.bilibili.com/video/${id}` },
    { pattern: /b23\.tv(?:\\)?\/([0-9a-zA-Z]+)/gi, type: 'bilibili', buildUrl: (id) => `https://b23.tv/${id}` },
    { pattern: /bili(?:22|23|33)\.cn\/([0-9a-zA-Z]+)/gi, type: 'bilibili', buildUrl: (id) => `https://bili23.cn/${id}` },
    { pattern: /bili2233\.cn\/([0-9a-zA-Z]+)/gi, type: 'bilibili', buildUrl: (id) => `https://bili2233.cn/${id}` },
    { pattern: /douyin\.com\/video\/(\d+)/gi, type: 'douyin', buildUrl: (id) => `https://www.douyin.com/video/${id}` },
    { pattern: /v\.douyin\.com\/([0-9a-zA-Z]+)/gi, type: 'douyin', buildUrl: (id) => `https://v.douyin.com/${id}` },
    { pattern: /kuaishou\.com\/short-video\/([0-9a-zA-Z]+)/gi, type: 'kuaishou', buildUrl: (id) => `https://www.kuaishou.com/short-video/${id}` },
    { pattern: /v\.kuaishou\.com\/([0-9a-zA-Z]+)/gi, type: 'kuaishou', buildUrl: (id) => `https://v.kuaishou.com/${id}` },
    { pattern: /xiaohongshu\.com\/discovery\/item\/([0-9a-zA-Z]+)/gi, type: 'xiaohongshu', buildUrl: (id) => `https://www.xiaohongshu.com/discovery/item/${id}` },
    { pattern: /xhslink\.com\/([0-9a-zA-Z]+)/gi, type: 'xiaohongshu', buildUrl: (id) => `https://xhslink.com/${id}` },
    { pattern: /weibo\.com\/\d+\/([0-9a-zA-Z]+)/gi, type: 'weibo', buildUrl: (id) => `https://weibo.com/${id}` },
    { pattern: /video\.weibo\.com\/show\?fid=([0-9a-zA-Z]+)/gi, type: 'weibo', buildUrl: (id) => `https://video.weibo.com/show?fid=${id}` },
    { pattern: /ixigua\.com\/(\d+)/gi, type: 'xigua', buildUrl: (id) => `https://www.ixigua.com/${id}` },
    { pattern: /youtube\.com\/watch\?v=([a-zA-Z0-9_-]+)/gi, type: 'youtube', buildUrl: (id) => `https://www.youtube.com/watch?v=${id}` },
    { pattern: /youtu\.be\/([a-zA-Z0-9_-]+)/gi, type: 'youtube', buildUrl: (id) => `https://youtu.be/${id}` },
    { pattern: /tiktok\.com\/@[\w.]+\/video\/(\d+)/gi, type: 'tiktok', buildUrl: (id) => `https://www.tiktok.com/@user/video/${id}` },
    { pattern: /vm\.tiktok\.com\/([0-9a-zA-Z]+)/gi, type: 'tiktok', buildUrl: (id) => `https://vm.tiktok.com/${id}` },
    { pattern: /acfun\.cn\/v\/(ac\d+)/gi, type: 'acfun', buildUrl: (id) => `https://www.acfun.cn/v/${id}` },
    { pattern: /zhihu\.com\/video\/(\d+)/gi, type: 'zhihu', buildUrl: (id) => `https://www.zhihu.com/video/${id}` },
    { pattern: /weishi\.qq\.com\/weishi\/feed\/([0-9a-zA-Z]+)/gi, type: 'weishi', buildUrl: (id) => `https://weishi.qq.com/weishi/feed/${id}` },
    { pattern: /huya\.com\/video\/([0-9a-zA-Z]+)/gi, type: 'huya', buildUrl: (id) => `https://www.huya.com/video/${id}` },
    { pattern: /haokan\.baidu\.com\/v\?vid=([0-9a-zA-Z]+)/gi, type: 'haokan', buildUrl: (id) => `https://haokan.baidu.com/v?vid=${id}` },
    { pattern: /meipai\.com\/media\/(\d+)/gi, type: 'meipai', buildUrl: (id) => `https://www.meipai.com/media/${id}` },
    { pattern: /twitter\.com\/\w+\/status\/(\d+)/gi, type: 'twitter', buildUrl: (id) => `https://twitter.com/i/status/${id}` },
    { pattern: /x\.com\/\w+\/status\/(\d+)/gi, type: 'twitter', buildUrl: (id) => `https://x.com/i/status/${id}` },
    { pattern: /instagram\.com\/p\/([0-9a-zA-Z_-]+)/gi, type: 'instagram', buildUrl: (id) => `https://www.instagram.com/p/${id}` },
    { pattern: /doubao\.com\/video\/(\d+)/gi, type: 'doubao', buildUrl: (id) => `https://www.doubao.com/video/${id}` },
  ];

  const matches: LinkMatch[] = [];
  const seen = new Set<string>();

  for (const rule of rules) {
    let match: RegExpExecArray | null;
    while ((match = rule.pattern.exec(content)) !== null) {
      const id = match[1];
      if (seen.has(id)) continue;
      seen.add(id);
      const url = rule.buildUrl(id);
      matches.push({ type: rule.type, url, id });
    }
  }
  return matches;
}

function extractUrl(content: string): string[] {
  const urlMatches = content.match(/https?:\/\/[^\s\"\'\>]+/gi) || [];
  return urlMatches.filter(url => {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      if (hostname === 'multimedia.nt.qq.com.cn') return false;
      return true;
    } catch {
      return false;
    }
  });
}

function extractAllUrlsFromMessage(session: any): string[] {
  const content = session.content?.trim() || '';
  const urls: string[] = [];

  const linkMatches = linkTypeParser(content);
  if (linkMatches.length > 0) {
    for (const match of linkMatches) {
      urls.push(match.url);
    }
    return [...new Set(urls)];
  }

  if (content) {
    const textUrls = extractUrl(content);
    urls.push(...textUrls);
  }

  if (session.elements) {
    for (const elem of session.elements) {
      if (elem.type === 'xml' && elem.data) {
        const urlRegex = /https?:\/\/[^\s<>"']+/gi;
        let match;
        while ((match = urlRegex.exec(elem.data)) !== null) {
          urls.push(match[0]);
        }
      } else if (elem.type === 'json' && elem.data) {
        try {
          const json = JSON.parse(elem.data);
          const extractFromObject = (obj: any) => {
            if (!obj || typeof obj !== 'object') return;
            for (const val of Object.values(obj)) {
              if (typeof val === 'string') {
                const match = val.match(/https?:\/\/[^\s<>"']+/gi);
                if (match) urls.push(...match);
              } else if (typeof val === 'object') extractFromObject(val);
            }
          };
          extractFromObject(json);
        } catch {}
      }
    }
  }

  return [...new Set(urls)];
}

function cleanUrl(url: string): string {
  try {
    url = url.replace(/&amp;/g, '&');
    const urlObj = new URL(url);
    if (urlObj.hostname.includes('douyin.com') || urlObj.hostname.includes('v.douyin.com')) {
      urlObj.searchParams.delete('source');
      urlObj.searchParams.delete('share_type');
      return urlObj.origin + urlObj.pathname;
    }
    return url;
  } catch (e) {
    return url.replace(/&amp;/g, '&').replace(/\?.*/, '');
  }
}

async function resolveShortUrl(url: string): Promise<string> {
  try {
    const res = await axios.get(url, {
      timeout: 10000,
      maxRedirects: 10,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.baidu.com/',
      },
      validateStatus: (status: number) => status >= 200 && status < 400,
    });
    const finalUrl = (res.request as any)?.res?.responseUrl || url;
    return cleanUrl(finalUrl);
  } catch (e) {
    return cleanUrl(url);
  }
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function formatPublishTime(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const y = d.getFullYear(), mo = (d.getMonth() + 1).toString().padStart(2, '0'), day = d.getDate().toString().padStart(2, '0'), H = d.getHours().toString().padStart(2, '0'), i = d.getMinutes().toString().padStart(2, '0');
  return `${y}年${mo}月${day}日 ${H}:${i}`;
}

function pickBestQuality(videoBackup: any[]): VideoQuality[] {
  if (!Array.isArray(videoBackup)) return [];
  return videoBackup
    .map(v => ({ quality: v.quality || v.label, url: v.url, bit_rate: v.bit_rate || 0 }))
    .sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0));
}

function parseApiResponse(raw: any, maxDescLen: number): ParsedData {
  debugLog('DEBUG', '原始API返回数据:', raw);
  const data = raw?.data || {};
  const extra = data.extra || {};

  let type = data.type || '';
  if (!type) {
    if (data.images?.length > 0 && !data.url) type = 'image';
    else if (data.live_photo?.length > 0) type = 'live_photo';
    else if (raw.msg === 'live' || data.live) type = 'live';
    else type = 'video';
  }

  const authorObj = data.author;
  let author = '', uid = '', avatar = '';
  if (authorObj && typeof authorObj === 'object') {
    author = authorObj.name || authorObj.author || '';
    uid = String(authorObj.id || data.uid || '');
    avatar = authorObj.avatar || data.avatar || '';
  } else {
    author = data.author || data.auther || '';
    uid = String(data.uid || '');
    avatar = data.avatar || '';
  }

  const title = data.title || '';
  const desc = (data.desc || data.description || '').slice(0, maxDescLen);
  const cover = data.cover || '';

  let video = '';
  let videos: VideoQuality[] = [];
  if (Array.isArray(data.video_backup) && data.video_backup.length) {
    const bestQ = pickBestQuality(data.video_backup);
    videos = bestQ;
    video = bestQ[0]?.url || data.url || '';
  } else if (Array.isArray(data.videos) && data.videos.length) {
    video = data.videos[0]?.url || '';
    videos = data.videos.map((v: any) => ({ quality: v.accept?.[0] || 'unknown', url: v.url }));
  } else {
    video = data.url || '';
  }

  const images: string[] = Array.isArray(data.images) ? data.images : [];
  const live_photo = Array.isArray(data.live_photo) ? data.live_photo : [];

  const music = {
    title: data.music?.title || data.music?.name || '',
    author: data.music?.author || data.music?.artist || '',
    cover: data.music?.cover || '',
    url: data.music?.url || ''
  };

  const stats = extra.statistics || {};
  const like = Number(data.like ?? stats.digg_count ?? 0);
  const comment = Number(stats.comment_count ?? 0);
  const collect = Number(stats.collect_count ?? 0);
  const share = Number(stats.share_count ?? 0);
  const play = Number(stats.play_count ?? 0);

  let duration = 0;
  if (data.duration) {
    duration = typeof data.duration === 'string' ? parseInt(data.duration, 10) : data.duration;
    if (duration > 1000000) duration = Math.floor(duration / 1000);
  } else if (extra.duration_ms) {
    duration = Math.floor(extra.duration_ms / 1000);
  }

  let publishTime = 0;
  if (data.time) {
    publishTime = typeof data.time === 'number' ? data.time : parseInt(data.time, 10);
    if (publishTime < 1000000000000) publishTime *= 1000;
  } else if (extra.create_time) {
    publishTime = extra.create_time * 1000;
  }

  return {
    type, title, desc, author, uid, avatar, cover,
    video, videos, images, live_photo, music,
    like, comment, collect, share, play,
    duration, publishTime
  };
}

function generateFormattedText(p: ParsedData, format: string): string {
  const imageCount = p.images.length || p.live_photo.length;
  const vars: Record<string, string> = {
    '标题': p.title,
    '作者': p.author,
    '简介': p.desc,
    '视频时长': p.duration > 0 ? formatDuration(p.duration) : '',
    '点赞数': String(p.like),
    '收藏数': String(p.collect),
    '转发数': String(p.share),
    '播放数': String(p.play),
    '评论数': String(p.comment),
    '发布时间': p.publishTime ? formatPublishTime(p.publishTime) : '',
    '图片数量': String(imageCount),
    '作者ID': p.uid,
    '封面': p.cover,
  };

  const lines = format.split('\n');
  const resultLines: string[] = [];

  for (const line of lines) {
    const varMatches = line.match(/\$\{([^}]+)\}/g);
    if (varMatches) {
      let allEmpty = true;
      for (const match of varMatches) {
        const varName = match.replace(/\$\{|\}/g, '');
        const val = vars[varName];
        if (val && val !== '0') {
          allEmpty = false;
          break;
        }
      }
      if (allEmpty) continue;
    }
    let newLine = line;
    for (const [key, value] of Object.entries(vars)) {
      newLine = newLine.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), value);
    }
    resultLines.push(newLine);
  }

  return resultLines.join('\n').trim();
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function buildForwardNode(session: any, content: any, botName: string) {
  let messageContent: any[];
  if (Array.isArray(content)) messageContent = content;
  else if (content && typeof content === 'object' && content.type) messageContent = [content];
  else messageContent = [h.text(String(content))];
  return h('node', { user: { nickname: botName.substring(0, 15), user_id: session.selfId } }, messageContent);
}

const urlCache = new Map<string, { data: ParsedData; expire: number }>();
const CACHE_TTL = 10 * 60 * 1000;

async function downloadVideoFile(videoUrl: string, tempDir: string, timeout: number, maxSizeMB: number): Promise<string> {
  await fs.mkdir(tempDir, { recursive: true });
  const fileName = `video_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.mp4`;
  const filePath = path.join(tempDir, fileName);
  
  const writer = createWriteStream(filePath);
  const response = await axios({
    method: 'GET',
    url: videoUrl,
    responseType: 'stream',
    timeout: timeout,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    }
  });

  const maxSizeBytes = maxSizeMB * 1024 * 1024;
  const contentLength = Number(response.headers['content-length'] || 0);
  
  if (maxSizeMB > 0 && contentLength > maxSizeBytes) {
    writer.destroy();
    await fs.unlink(filePath).catch(() => {});
    throw new Error(`视频文件过大(${Math.round(contentLength/1024/1024)}MB)，超过限制(${maxSizeMB}MB)`);
  }

  let downloadedSize = 0;
  response.data.on('data', (chunk: Buffer) => {
    downloadedSize += chunk.length;
    if (maxSizeMB > 0 && downloadedSize > maxSizeBytes) {
      response.data.destroy();
      writer.destroy();
      fs.unlink(filePath).catch(() => {});
      throw new Error(`视频文件过大，超过限制(${maxSizeMB}MB)`);
    }
  });

  await pipeline(response.data, writer);
  return filePath;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isSpecialPlatformVideo(url: string): boolean {
  const specialHosts = [
    'bilibili.com',
    'akamaized.net',
    'hdslb.com',
    'xiaohongshu.com',
    'xhslink.com',
    'zhihu.com',
    'weibo.com',
    'sinaimg.cn'
  ];
  return specialHosts.some(host => url.includes(host));
}

export function apply(ctx: Context, config: any) {
  debugEnabled = config.debug || false;
  debugLog('INFO', '插件初始化开始');

  const texts = {
    waitingTipText: config.waitingTipText || '正在解析视频，请稍候...',
    unsupportedPlatformText: config.unsupportedPlatformText || '不支持该平台链接',
    invalidLinkText: config.invalidLinkText || '无效的视频链接',
    parseErrorPrefix: config.parseErrorPrefix || '❌ 解析失败：',
    parseErrorItemFormat: config.parseErrorItemFormat || '【${url}】: ${msg}',
  };

  const http: AxiosInstance = axios.create({
    timeout: config.timeout,
    headers: {
      'User-Agent': config.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://www.baidu.com/',
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  });

  async function fetchApi(url: string): Promise<ParsedData> {
    const cacheKey = url;
    const cached = urlCache.get(cacheKey);
    if (cached && cached.expire > Date.now()) {
      debugLog('DEBUG', `使用缓存: ${url}`);
      return cached.data;
    }

    debugLog('INFO', `调用API解析: ${url}`);
    let lastError: Error | null = null;
    for (let i = 0; i <= config.retryTimes; i++) {
      try {
        const res = await http.get('https://api.bugpk.com/api/short_videos', {
          params: { url },
          timeout: config.timeout
        });
        debugLog('DEBUG', `API响应: ${JSON.stringify(res.data)}`);
        if (res.data && (res.data.code === 200 || res.data.code === 0)) {
          const parsed = parseApiResponse(res.data, config.maxDescLength);
          urlCache.set(cacheKey, { data: parsed, expire: Date.now() + CACHE_TTL });
          return parsed;
        }
        throw new Error(res.data?.msg || '解析失败');
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        debugLog('ERROR', `第${i+1}次请求失败: ${lastError.message}`);
        if (i < config.retryTimes) {
          await delay(config.retryInterval);
        }
      }
    }
    throw lastError || new Error('API请求全部失败');
  }

  async function parseUrl(url: string): Promise<{ success: true; data: ParsedData } | { success: false; msg: string }> {
    const realUrl = await resolveShortUrl(url);
    const candidates = [realUrl, url];
    for (const candidate of [...new Set(candidates)]) {
      try {
        const info = await fetchApi(candidate);
        return { success: true, data: info };
      } catch (error) {
        debugLog('ERROR', `候选链接解析失败: ${candidate}`, getErrorMessage(error));
      }
    }
    return { success: false, msg: texts.unsupportedPlatformText };
  }

  async function processSingleUrl(url: string): Promise<
    { success: true; data: { text: string; parsed: ParsedData } } | 
    { success: false; msg: string }
  > {
    const result = await parseUrl(url);
    if (!result.success) return result;
    const text = generateFormattedText(result.data, config.unifiedMessageFormat);
    return { success: true, data: { text, parsed: result.data } };
  }

  async function sendWithTimeout(session: any, content: any, customRetries?: number): Promise<any> {
    const maxRetries = customRetries ?? config.retryTimes ?? 3;
    const retryDelay = config.retryInterval || 1000;
    let timeoutId: NodeJS.Timeout | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        let sendPromise = session.send(content);
        if (config.videoSendTimeout > 0) {
          const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error('发送超时')), config.videoSendTimeout);
          });
          const result = await Promise.race([sendPromise, timeoutPromise]);
          if (timeoutId) clearTimeout(timeoutId);
          return result;
        } else {
          return await sendPromise;
        }
      } catch (err) {
        if (timeoutId) clearTimeout(timeoutId);
        const errMsg = getErrorMessage(err);
        debugLog('ERROR', `第${attempt + 1}次发送失败: ${errMsg}`);
        if (attempt < maxRetries) {
          debugLog('INFO', `等待 ${retryDelay}ms 后进行第 ${attempt + 2} 次重试`);
          await delay(retryDelay);
        } else {
          if (!config.ignoreSendError) throw err;
          return null;
        }
      }
    }
    return null;
  }

  async function sendVideoFile(session: any, videoUrl: string): Promise<any> {
    if (!videoUrl) throw new Error('视频链接为空');

    const shouldForceDownload = config.forceDownloadVideo || isSpecialPlatformVideo(videoUrl);
    
    if (!shouldForceDownload) {
      try {
        debugLog('INFO', `尝试直接发送视频URL: ${videoUrl.substring(0, 100)}...`);
        return await sendWithTimeout(session, h.video(videoUrl));
      } catch (err) {
        debugLog('ERROR', `直接发送URL失败，开始下载视频: ${getErrorMessage(err)}`);
      }
    } else {
      debugLog('INFO', `检测到特殊平台视频，强制下载后发送: ${videoUrl.substring(0, 100)}...`);
    }
    
    let tempFilePath: string | null = null;
    try {
      tempFilePath = await downloadVideoFile(
        videoUrl, 
        config.tempDir || './temp_videos', 
        config.videoDownloadTimeout || 120000,
        config.maxVideoSize || 0
      );
      const localFile = `file://${path.resolve(tempFilePath)}`;
      debugLog('INFO', `视频下载完成，发送本地文件: ${localFile}`);
      return await sendWithTimeout(session, h.video(localFile));
    } finally {
      if (tempFilePath) {
        fs.unlink(tempFilePath).catch(e => debugLog('WARN', `删除临时文件失败: ${e}`));
      }
    }
  }

  async function flush(session: any, urls: string[]) {
    const uniqueUrls = [...new Set(urls)];
    const items: { text: string; parsed: ParsedData }[] = [];
    const errors: string[] = [];

    const concurrency = 3;
    const chunks = [];
    for (let i = 0; i < uniqueUrls.length; i += concurrency) {
      chunks.push(uniqueUrls.slice(i, i + concurrency));
    }
    for (const chunk of chunks) {
      const results = await Promise.all(chunk.map(url => processSingleUrl(url)));
      for (let idx = 0; idx < results.length; idx++) {
        const res = results[idx];
        if (res.success) {
          items.push(res.data);
        } else {
          const url = chunk[idx];
          const item = texts.parseErrorItemFormat
            .replace(/\$\{url\}/g, url.length > 50 ? url.slice(0,50)+'...' : url)
            .replace(/\$\{msg\}/g, res.msg);
          errors.push(item);
        }
      }
    }

    if (errors.length) {
      await sendWithTimeout(session, `${texts.parseErrorPrefix}\n${errors.join('\n')}`);
      await delay(500);
    }
    if (!items.length) return;

    const enableForward = config.enableForward && session.platform === 'onebot';
    const botName = config.botName || '视频解析机器人';
    const videoItems: ParsedData[] = [];

    if (enableForward) {
      const forwardMessages: any[] = [];
      for (const item of items) {
        const p = item.parsed;
        const text = item.text;

        if (text && config.showImageText) {
          forwardMessages.push(buildForwardNode(session, text, botName));
        }
        if (p.cover && p.type !== 'live_photo' && !(p.type === 'live' && (p.live_photo?.length || p.images?.length))) {
          forwardMessages.push(buildForwardNode(session, h.image(p.cover), botName));
        }
        if (p.type === 'image' || p.type === 'live_photo' || (p.type === 'live' && (p.live_photo?.length || p.images?.length))) {
          const imageUrls = p.images?.length ? p.images : (p.live_photo?.map(lp => lp.image) ?? []);
          for (const imgUrl of imageUrls) {
            forwardMessages.push(buildForwardNode(session, h.image(imgUrl), botName));
          }
        }
        if (p.video && config.showVideoFile && (p.type === 'video' || (p.type === 'live' && !p.live_photo?.length && !p.images?.length))) {
          videoItems.push(p);
        }
      }

      if (forwardMessages.length) {
        const forwardMsg = h('message', { forward: true }, forwardMessages.slice(0, 100));
        try {
          await sendWithTimeout(session, forwardMsg, config.retryTimes);
        } catch (err) {
          debugLog('ERROR', '合并转发发送失败，降级为逐条发送:', err);
          for (const node of forwardMessages) {
            await sendWithTimeout(session, node.data.content).catch(() => {});
            await delay(300);
          }
        }
      }

      for (const p of videoItems) {
        try {
          await sendVideoFile(session, p.video);
        } catch (err) {
          debugLog('ERROR', `视频发送失败（降级发送链接）: ${getErrorMessage(err)}`);
          await sendWithTimeout(session, `视频链接：${p.video}`).catch(() => {});
        }
        await delay(500);
      }
    } else {
      for (const item of items) {
        const p = item.parsed;
        const text = item.text;

        if (text && config.showImageText) {
          await sendWithTimeout(session, text);
          await delay(300);
        }
        if (p.cover && p.type !== 'live_photo' && !(p.type === 'live' && (p.live_photo?.length || p.images?.length))) {
          await sendWithTimeout(session, h.image(p.cover)).catch(() => {});
          await delay(300);
        }
        if (p.video && config.showVideoFile && (p.type === 'video' || (p.type === 'live' && !p.live_photo?.length && !p.images?.length))) {
          try {
            await sendVideoFile(session, p.video);
          } catch (err) {
            debugLog('ERROR', `视频发送失败（降级发送链接）: ${getErrorMessage(err)}`);
            await sendWithTimeout(session, `视频链接：${p.video}`).catch(() => {});
          }
          await delay(500);
        }
        if (p.type === 'image' || p.type === 'live_photo' || (p.type === 'live' && (p.live_photo?.length || p.images?.length))) {
          const imageUrls = p.images?.length ? p.images : (p.live_photo?.map(lp => lp.image) ?? []);
          for (const imgUrl of imageUrls) {
            await sendWithTimeout(session, h.image(imgUrl)).catch(() => {});
            await delay(200);
          }
        }
      }
    }
  }

  ctx.on('message', async (session) => {
    if (!config.enable) return;

    // 修复：使用正确的小写subtype属性名
    if (session.subtype === 'file_upload') return;
    if (session.elements?.some(elem => elem.type === 'file' || elem.type === 'folder')) return;

    const urls = extractAllUrlsFromMessage(session);
    if (!urls.length) return;

    if (config.showWaitingTip) {
      try { await sendWithTimeout(session, texts.waitingTipText); } catch {}
    }
    await flush(session, urls);
  });

  ctx.command('parse <url>', '手动解析视频').action(async ({ session }, url) => {
    const us = extractUrl(url);
    if (!us.length) {
      await sendWithTimeout(session, texts.invalidLinkText);
      return;
    }
    await flush(session, us);
  });

  setInterval(() => {
    const now = Date.now();
    for (const [key, { expire }] of urlCache.entries()) {
      if (expire <= now) urlCache.delete(key);
    }
  }, 60000);

  process.on('exit', async () => {
    try {
      const tempDir = config.tempDir || './temp_videos';
      const files = await fs.readdir(tempDir);
      for (const file of files) {
        if (file.startsWith('video_') && file.endsWith('.mp4')) {
          await fs.unlink(path.join(tempDir, file)).catch(() => {});
        }
      }
    } catch {}
  });

  debugLog('INFO', '插件初始化完成');
}