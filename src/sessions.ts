export interface Session {
    step?: "WAIT_USER" | "WAIT_PACKAGE";
    selectedUserId?: string;
    emailOrUsername?: string;
    selectedMonths?: number;
    waitingReceipt?: boolean;
    activeSupport?: boolean;
}

// Foydalanuvchi Telegram ID -> Session
// Eslatma: bu xotirada (in-memory) saqlanadi. Bot qayta ishga tushsa
// (deploy, crash, restart) barcha sessiyalar o'chib ketadi.
// Production uchun buni Redis yoki DB'ga ko'chirish tavsiya etiladi.
export const sessions = new Map<number, Session>();