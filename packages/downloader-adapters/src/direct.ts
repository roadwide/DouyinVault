import {
  DownloadError,
  isAllowedMediaUrl,
  type DownloadProgress,
  type DownloadResult,
  type MediaDownloader,
  type MediaInput,
  type ResolvedMedia,
} from "@vault/core";
import { httpDownloadToFile } from "./http.js";

export class DirectMediaDownloader implements MediaDownloader {
  readonly name = "direct";

  constructor(
    private readonly options: {
      extraHosts?: readonly string[];
      allowLoopback?: boolean;
      timeoutSeconds?: number;
    } = {},
  ) {}

  private isAllowed(url: string): boolean {
    return isAllowedMediaUrl(url, {
      extraHosts: this.options.extraHosts,
      allowLoopback: this.options.allowLoopback,
    });
  }

  supports(input: MediaInput): boolean {
    return Boolean(input.mediaUrl);
  }

  async resolve(input: MediaInput): Promise<ResolvedMedia> {
    if (!input.mediaUrl) throw new DownloadError("UNRESOLVED", "消息没有携带可下载的媒体地址");
    if (!this.isAllowed(input.mediaUrl)) {
      throw new DownloadError("RESOURCE_UNAVAILABLE", "消息中的媒体地址不在允许的域名范围内");
    }
    return {
      url: input.mediaUrl,
      kind: "video",
      container: "mp4",
      title: input.title,
      coverUrl: input.coverUrl,
      headers: { Referer: "https://www.douyin.com/" },
    };
  }

  async download(
    media: ResolvedMedia,
    outputPath: string,
    onProgress: (progress: DownloadProgress) => void,
    signal?: AbortSignal,
  ): Promise<DownloadResult> {
    const result = await httpDownloadToFile(media.url, outputPath, {
      headers: media.headers,
      timeoutMs: (this.options.timeoutSeconds ?? 120) * 1000,
      signal,
      validateUrl: (url) => this.isAllowed(url),
      referer: "https://www.douyin.com/",
      onProgress,
    });
    return {
      filePath: outputPath,
      bytesWritten: result.bytesWritten,
      contentType: result.contentType,
    };
  }
}
