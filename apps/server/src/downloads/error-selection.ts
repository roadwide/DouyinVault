import { DownloadError, toVaultError, type VaultError } from "@vault/core";

export interface AdapterFailure {
  adapter: string;
  error: VaultError;
}

/**
 * Pick the most actionable error after every download adapter has failed.
 *
 * Order:
 * 1. A transient error, so the job can retry.
 * 2. A concrete media/configuration error (invalid format, missing binary).
 * 3. The IM resolver's reason when it could not produce a signed link.
 * 4. The primary downloader's reason instead of yt-dlp's generic cookie
 *    message, because yt-dlp is the last resort and its message would wrongly
 *    imply that the Douyin account is not connected.
 */
export function selectDownloadError(options: {
  retryableError: unknown;
  specificError: unknown;
  lastError: unknown;
  resolveFailure: string | null;
  failures: readonly AdapterFailure[];
}): VaultError {
  const error = toVaultError(
    options.retryableError ?? options.specificError ?? options.lastError,
  );
  if (options.retryableError || options.specificError || error.code !== "RESOURCE_UNAVAILABLE") {
    return error;
  }
  if (options.resolveFailure) {
    return new DownloadError(
      "RESOURCE_UNAVAILABLE",
      `主 IM 适配器无法解析该作品：${options.resolveFailure}`,
      { retryable: false },
    );
  }
  const primaryFailure = options.failures.find((failure) => failure.adapter !== "yt-dlp");
  return primaryFailure?.error ?? error;
}
