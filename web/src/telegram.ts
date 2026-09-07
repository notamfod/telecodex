export type TelegramTheme = "white" | "g100";

interface TelegramWebApp {
  initData: string;
  initDataUnsafe?: { start_param?: string };
  colorScheme: "light" | "dark";
  ready(): void;
  expand(): void;
  openTelegramLink(url: string): void;
  openLink?(url: string): void;
  onEvent(event: "themeChanged", callback: () => void): void;
  offEvent(event: "themeChanged", callback: () => void): void;
  HapticFeedback?: {
    impactOccurred(style: "light" | "medium" | "heavy"): void;
    notificationOccurred(type: "error" | "success" | "warning"): void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp: TelegramWebApp };
  }
}

export function getTelegramWebApp(): TelegramWebApp | undefined {
  return window.Telegram?.WebApp;
}

export function carbonTheme(app = getTelegramWebApp()): TelegramTheme {
  return app?.colorScheme === "dark" ? "g100" : "white";
}

export function initializeTelegram(onTheme: (theme: TelegramTheme) => void): () => void {
  const app = getTelegramWebApp();
  if (!app) return () => {};

  const updateTheme = () => onTheme(carbonTheme(app));
  app.ready();
  app.expand();
  updateTheme();
  app.onEvent("themeChanged", updateTheme);
  return () => app.offEvent("themeChanged", updateTheme);
}

export function openTelegramUrl(url: string): void {
  const app = getTelegramWebApp();
  if (app) app.openTelegramLink(url);
  else window.location.assign(url);
}

export function openExternalUrl(url: string): void {
  const app = getTelegramWebApp();
  if (app?.openLink) app.openLink(url);
  else window.location.assign(url);
}

export function haptic(type: "error" | "success" | "tap"): void {
  const feedback = getTelegramWebApp()?.HapticFeedback;
  if (type === "tap") feedback?.impactOccurred("light");
  else feedback?.notificationOccurred(type);
}
