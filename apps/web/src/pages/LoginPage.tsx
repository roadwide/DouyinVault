import { useState, type FormEvent } from "react";
import { ArrowRight, KeyRound, LockKeyhole, ShieldCheck, TerminalSquare } from "lucide-react";
import { useAuth } from "../hooks/useAuth";
import { AlertBanner, Button, Input } from "../components/ui";
import { errorMessage } from "../lib/utils";

export function LoginPage() {
  const { session, login, setup } = useAuth();
  const setupRequired = Boolean(session?.setupRequired);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (setupRequired && password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    if (setupRequired && password.length < 10) {
      setError("密码至少需要 10 个字符");
      return;
    }
    setLoading(true);
    try {
      if (setupRequired) await setup(token, password);
      else await login(password);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden px-4 py-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(50rem_36rem_at_50%_-10%,rgba(254,44,85,0.14),transparent_60%)]" />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.018)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.018)_1px,transparent_1px)] bg-[size:56px_56px] [mask-image:radial-gradient(ellipse_at_center,black,transparent_72%)]" />
      <div className="relative z-10 grid w-full max-w-4xl overflow-hidden rounded-3xl border border-white/[0.08] bg-ink-900/80 shadow-2xl backdrop-blur-xl md:grid-cols-[1.05fr_1fr]">
        <div className="relative hidden flex-col justify-between overflow-hidden border-r border-white/[0.06] p-9 md:flex">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(254,44,85,0.16),transparent_45%),radial-gradient(circle_at_85%_80%,rgba(37,244,238,0.09),transparent_45%)]" />
          <div className="grain absolute inset-0" />
          <div className="relative">
            <div className="flex items-center gap-3">
              <div className="relative flex size-10 items-center justify-center rounded-xl border border-white/10 bg-ink-850">
                <span className="text-base font-bold tracking-tighter">DV</span>
                <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-brand-500" />
                <span className="absolute -bottom-1 -left-1 size-2 rounded-full bg-aqua-400/80" />
              </div>
              <div>
                <p className="text-sm font-semibold tracking-tight">Douyin Vault</p>
                <p className="text-[10px] uppercase tracking-[0.2em] text-ink-500">Time Capsule</p>
              </div>
            </div>
            <h1 className="mt-12 max-w-sm text-3xl font-semibold leading-tight tracking-tight text-ink-50">
              群友分享的视频，
              <br />
              <span className="text-brand-400">不再错过。</span>
            </h1>
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-ink-400">
              自动监听你授权的抖音群聊，在作品失效前缓存到本地。没有云端账号，没有算法，只有你自己的视频收件箱。
            </p>
          </div>
          <div className="relative space-y-3 text-xs text-ink-500">
            <div className="flex items-center gap-2">
              <ShieldCheck className="size-3.5 text-emerald-400" />
              登录凭据仅保存在本机受限目录
            </div>
            <div className="flex items-center gap-2">
              <LockKeyhole className="size-3.5 text-aqua-400" />
              管理接口默认关闭匿名访问
            </div>
            <div className="flex items-center gap-2">
              <TerminalSquare className="size-3.5 text-ink-400" />
              视频与数据库只属于这台设备
            </div>
          </div>
        </div>

        <div className="p-7 sm:p-9">
          <div className="mb-8 md:hidden">
            <div className="flex items-center gap-3">
              <div className="flex size-9 items-center justify-center rounded-xl border border-white/10 bg-ink-850 text-sm font-bold">
                DV
              </div>
              <div>
                <p className="text-sm font-semibold">Douyin Vault</p>
                <p className="text-[10px] uppercase tracking-[0.18em] text-ink-500">Time Capsule</p>
              </div>
            </div>
          </div>

          <div className="mb-6">
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-brand-400">
              {setupRequired ? "First Run" : "Admin Access"}
            </p>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-ink-50">
              {setupRequired ? "创建管理员密码" : "进入时光仓"}
            </h2>
            <p className="mt-1.5 text-xs leading-relaxed text-ink-400">
              {setupRequired
                ? "首次启动需要一次性安装令牌。它保存在服务器的 data/sessions/setup-token.txt，设置密码后立即删除。"
                : "请输入管理员密码。所有操作仅在本机与受 Cloudflare Access 保护的入口之间传输。"}
            </p>
          </div>

          {setupRequired ? (
            <div className="mb-5 rounded-xl border border-white/[0.07] bg-black/25 px-4 py-3">
              <p className="text-[11px] text-ink-400">在运行服务的机器上获取安装令牌：</p>
              <code className="mt-1.5 block rounded-lg bg-ink-950/80 px-3 py-2 text-xs text-aqua-300">
                pnpm setup-token
              </code>
            </div>
          ) : null}

          <form onSubmit={(event) => void submit(event)} className="space-y-3.5">
            {setupRequired ? (
              <label className="block">
                <span className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-ink-300">
                  <KeyRound className="size-3.5" /> 一次性安装令牌
                </span>
                <Input
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder="粘贴 setup-token.txt 中的令牌"
                  autoComplete="one-time-code"
                  required
                  autoFocus
                />
              </label>
            ) : null}
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-ink-300">管理员密码</span>
              <Input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={setupRequired ? "至少 10 个字符" : "输入密码"}
                autoComplete={setupRequired ? "new-password" : "current-password"}
                required
                autoFocus={!setupRequired}
              />
            </label>
            {setupRequired ? (
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-ink-300">确认密码</span>
                <Input
                  type="password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  placeholder="再次输入密码"
                  autoComplete="new-password"
                  required
                />
              </label>
            ) : null}
            {error ? <AlertBanner tone="danger" title="无法继续">{error}</AlertBanner> : null}
            <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading}>
              {setupRequired ? "完成设置并进入" : "登录"}
              <ArrowRight className="size-4" />
            </Button>
          </form>

          <p className="mt-6 text-center text-[10px] leading-relaxed text-ink-600">
            本项目仅用于缓存你已获授权访问的群聊内容。请遵守平台条款与适用法律。
          </p>
        </div>
      </div>
    </div>
  );
}
