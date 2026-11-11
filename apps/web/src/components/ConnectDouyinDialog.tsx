import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink, QrCode, RefreshCw, Smartphone } from "lucide-react";
import { api } from "../api/client";
import type { AuthStatus, LoginChallenge } from "../api/types";
import { useToast } from "./Toast";
import { AlertBanner, Badge, Button, Modal, Spinner } from "./ui";
import { errorMessage } from "../lib/utils";

export function ConnectDouyinDialog({
  open,
  onClose,
  onConnected,
}: {
  open: boolean;
  onClose: () => void;
  onConnected: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [challenge, setChallenge] = useState<LoginChallenge | null>(null);
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const started = useRef(false);
  const { toast } = useToast();

  const loadStatus = useCallback(async () => {
    try {
      const next = await api.get<AuthStatus>("/api/v1/auth/status");
      setStatus(next);
      if (next.status === "CONNECTED") {
        toast("抖音账号已连接，监听即将开始", "success");
        onConnected();
        onClose();
      }
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [onConnected, onClose, toast]);

  const startLogin = useCallback(async () => {
    setLoading(true);
    setError(null);
    setChallenge(null);
    try {
      const result = await api.post<{ challenge: LoginChallenge; status: AuthStatus }>(
        "/api/v1/auth/login",
      );
      setChallenge(result.challenge);
      setStatus(result.status);
      if (result.status.status === "CONNECTED") {
        onConnected();
        onClose();
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [onClose, onConnected]);

  useEffect(() => {
    if (!open) {
      started.current = false;
      return;
    }
    if (!started.current) {
      started.current = true;
      void startLogin();
    }
    const timer = window.setInterval(() => void loadStatus(), 3000);
    return () => window.clearInterval(timer);
  }, [open, startLogin, loadStatus]);

  const completeDemo = async () => {
    setLoading(true);
    setError(null);
    try {
      await api.post("/api/v1/auth/demo/complete");
      await loadStatus();
      toast("演示账号已连接", "success");
      onConnected();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const copyVerification = async () => {
    if (!challenge?.verificationUrl) return;
    try {
      await navigator.clipboard.writeText(challenge.verificationUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast("复制失败，请手动选择链接", "error");
    }
  };

  const adapter = status?.adapter ?? "douyin-im";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="连接抖音账号"
      description="登录凭据只保存在本机受限目录，不会通过接口返回或写入日志。"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={() => void loadStatus()} icon={RefreshCw}>
            刷新状态
          </Button>
          <Button variant="outline" onClick={onClose}>
            稍后连接
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {status ? (
          <div className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
            <div>
              <p className="text-xs text-ink-400">当前状态</p>
              <p className="mt-0.5 text-sm font-medium text-ink-100">{status.status}</p>
            </div>
            <Badge tone={status.status === "CONNECTED" ? "success" : "warning"} dot>
              {adapter}
            </Badge>
          </div>
        ) : null}

        {loading && !challenge ? (
          <div className="flex flex-col items-center gap-3 py-10">
            <Spinner className="size-6" />
            <p className="text-sm text-ink-300">正在启动登录流程…</p>
            <p className="text-xs text-ink-500">首次加载 IM SDK 可能需要几秒</p>
          </div>
        ) : null}

        {challenge?.qrDataUrl ? (
          <div className="flex flex-col items-center gap-4 py-2">
            <div className="rounded-2xl bg-white p-3 shadow-2xl">
              <img src={challenge.qrDataUrl} alt="抖音登录二维码" className="size-52 rounded-lg object-contain" />
            </div>
            <div className="text-center">
              <p className="flex items-center justify-center gap-2 text-sm font-medium text-ink-100">
                <Smartphone className="size-4 text-brand-400" /> 使用抖音 App 扫码登录
              </p>
              <p className="mt-1 max-w-sm text-xs leading-relaxed text-ink-400">
                扫码后请在手机上确认。二维码仅保存在内存中，成功后立即失效。登录完成后本窗口会自动关闭。
              </p>
            </div>
            {adapter === "mock" ? (
              <Button variant="primary" onClick={() => void completeDemo()} loading={loading}>
                模拟扫码成功（演示模式）
              </Button>
            ) : null}
          </div>
        ) : null}

        {challenge?.kind === "verification" ? (
          <div className="space-y-3">
            <AlertBanner tone="warning" title="抖音要求二次验证">
              {challenge.hint ??
                "请在运行 Douyin Vault 的机器上完成官方验证。系统不会绕过验证，也不会自动重试。"}
            </AlertBanner>
            {challenge.verificationUrl ? (
              <div className="rounded-xl border border-white/[0.07] bg-black/30 p-3">
                <p className="mb-2 text-[11px] uppercase tracking-wide text-ink-500">本机验证链接</p>
                <div className="flex items-start gap-2">
                  <code className="min-w-0 flex-1 break-all text-[11px] leading-relaxed text-ink-300">
                    {challenge.verificationUrl}
                  </code>
                  <Button variant="ghost" size="icon" onClick={() => void copyVerification()} aria-label="复制验证链接">
                    {copied ? <Check className="size-4 text-emerald-400" /> : <Copy className="size-4" />}
                  </Button>
                  <a href={challenge.verificationUrl} target="_blank" rel="noreferrer">
                    <Button variant="ghost" size="icon" aria-label="打开验证链接">
                      <ExternalLink className="size-4" />
                    </Button>
                  </a>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-ink-500">
                  验证页只监听本机回环地址。远程访问时请通过 SSH 端口转发，或在 Mac mini 本机浏览器中打开。
                </p>
              </div>
            ) : null}
          </div>
        ) : null}

        {!loading && !challenge && !error && status?.status !== "CONNECTED" ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <QrCode className="size-8 text-ink-500" />
            <p className="text-sm text-ink-300">暂未获取到登录二维码</p>
            <Button variant="primary" onClick={() => void startLogin()} icon={RefreshCw}>
              重新获取
            </Button>
          </div>
        ) : null}

        {error ? (
          <AlertBanner tone="danger" title="登录流程出错">
            {error}
          </AlertBanner>
        ) : null}

        {adapter === "mock" ? (
          <p className="text-center text-[11px] text-ink-500">
            当前使用离线演示适配器，不会连接真实抖音。真实使用请切换 IM_ADAPTER=douyin-im。
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
