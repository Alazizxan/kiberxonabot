import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Telegraf, Markup, Context } from "telegraf";

import {
    ADMIN_IDS,
    SUPPORT_IDS,
    PAYMENT_CARDS,
    PREMIUM_PRICES,
} from "./constants";

import { sessions, Session } from "./sessions";

// ----------------------------------------------------------------------
// Helper: barcha admin + support ID'larni bitta ro'yxatda birlashtiramiz
// (approve/reject/reply kabi amallarni faqat shu ro'yxatdagilar qila oladi)
// ----------------------------------------------------------------------
const STAFF_IDS = new Set<number>([...ADMIN_IDS, ...SUPPORT_IDS]);

function isStaff(userId: number): boolean {
    return STAFF_IDS.has(userId);
}

function isAdmin(userId: number): boolean {
    return ADMIN_IDS.includes(userId);
}

export class TelegramService {
    private bot: Telegraf;

    // admin/support ID -> qaysi userga javob yozayotgani
    private adminReplyMap = new Map<number, number>();

    private prisma: PrismaClient;

    constructor() {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        const databaseUrl = process.env.DATABASE_URL;

        if (!token) {
            throw new Error(
                "TELEGRAM_BOT_TOKEN environment variable topilmadi.",
            );
        }

        if (!databaseUrl) {
            throw new Error(
                "DATABASE_URL environment variable topilmadi.",
            );
        }

        // Prisma 7'da PrismaClient endi driver adapter talab qiladi.
        // max — botga alohida ulanishlar sonini cheklab qo'yamiz,
        // shunda backend bilan bitta bazadagi max_connections tugab qolmaydi.
        const adapter = new PrismaPg({
            connectionString: databaseUrl,
            max: Number(process.env.BOT_DB_POOL_SIZE ?? 5),
        });
        this.prisma = new PrismaClient({ adapter });

        this.bot = new Telegraf(token);
    }

    // --------------------------------------------------------------
    // START — bot va handlerlarni ishga tushiradi
    // --------------------------------------------------------------
    async start(): Promise<void> {
        console.log("BOT STARTING");

        this.registerErrorHandler();
        this.registerHandlers();

        console.log("HANDLERS REGISTERED");

        try {
            await this.bot.launch();
            console.log("BOT STARTED");
        } catch (err) {
            console.error("BOT LAUNCH FAILED:", err);
            throw err;
        }

        // Signal handlerlar faqat bitta marta va to'g'ri joyda ro'yxatga olinadi
        process.once("SIGINT", () => this.bot.stop("SIGINT"));
        process.once("SIGTERM", () => this.bot.stop("SIGTERM"));
    }

    async onModuleDestroy(): Promise<void> {
        this.bot.stop();
        await this.prisma.$disconnect();
    }

    // --------------------------------------------------------------
    // Global xato ushlagich — bitta handlerdagi xato butun botni
    // to'xtatib qo'ymasligi uchun
    // --------------------------------------------------------------
    private registerErrorHandler(): void {
        this.bot.catch((err, ctx) => {
            console.error(
                `Bot xatosi [update ${ctx.update.update_id}]:`,
                err,
            );

            ctx
                .reply("⚠️ Kutilmagan xatolik yuz berdi. Qaytadan urinib ko'ring.")
                .catch(() => {
                    /* reply yuborib bo'lmasa ham botni yiqitmaymiz */
                });
        });
    }

    private registerHandlers(): void {
        this.registerStartHandler();
        this.registerPhoneVerificationHandlers();
        this.registerPremiumStatusHandler();
        this.registerPremiumPurchaseHandler();
        this.registerSupportHandler();
        this.registerCloseCommand();
        this.registerTextHandler();
        this.registerPremiumPackageAction();
        this.registerReceiptPhotoHandler();
        this.registerApproveAction();
        this.registerRejectAction();
        this.registerReplyAction();
    }

    // --------------------------------------------------------------
    // /start (oddiy /start hamda mobil ilovadan ?start=verify deep-link)
    // --------------------------------------------------------------
    private registerStartHandler(): void {
        this.bot.start(async (ctx) => {
            // Mobil ilova foydalanuvchini t.me/BotUsername?start=verify orqali
            // yuborsa, to'g'ridan-to'g'ri telefon so'rash oynasini ko'rsatamiz.
            if (ctx.startPayload === "verify") {
                await this.sendContactRequest(ctx);
                return;
            }

            await ctx.reply(
                `👋 KiberXona botiga xush kelibsiz

Bu yerda siz:

⭐ Premium sotib olishingiz
💬 Support bilan bog'lanishingiz
👑 Premium holatini tekshirishingiz mumkin
📱 Telefon raqamingizni tasdiqlashingiz mumkin`,
                this.mainMenuKeyboard(),
            );
        });
    }

    // Asosiy menyu klaviaturasi — bir joyda saqlanadi, chunki bir nechta
    // handler (start, contact tasdiqlash) shu menyuga qaytishi kerak.
    private mainMenuKeyboard() {
        return Markup.keyboard([
            ["⭐ Premium sotib olish"],
            ["👑 Premium holatim"],
            ["📱 Raqamni tasdiqlash", "OTP"],
            ["💬 Support"],
        ])
            .resize()
            .persistent();
    }

    // --------------------------------------------------------------
    // 📱 Telefon raqamni tasdiqlash (SMS OTP o'rniga)
    // --------------------------------------------------------------
    private registerPhoneVerificationHandlers(): void {
        // 1) Foydalanuvchi menyudan "📱 Raqamni tasdiqlash" yoki "OTP"ni bosadi
        //    (ikkisi ham bitta xatti-harakatni ishga tushiradi)
        this.bot.hears(
            ["📱 Raqamni tasdiqlash", "OTP"],
            async (ctx) => {
                await this.sendContactRequest(ctx);
            },
        );

        // 2) Foydalanuvchi kontakt tugmasini bosgach, Telegram "contact"
        //    turidagi xabar yuboradi (bu "text" handleriga umuman tegmaydi)
        this.bot.on("contact", async (ctx) => {
            const contact = ctx.message.contact;

            // Faqat o'zining raqamini yuborganini tekshiramiz — boshqa
            // birovning kontaktini forward qilib firibgarlik qilmasin
            if (contact.user_id && contact.user_id !== ctx.from.id) {
                await ctx.reply(
                    "❌ Iltimos, faqat o'zingizning telefon raqamingizni yuboring.",
                    this.mainMenuKeyboard(),
                );
                return;
            }

            const digits = contact.phone_number.replace(/\D/g, "");
            const withPlus = `+${digits}`;

            try {
                // Backend raqamni "+998..." yoki "998..." ko'rinishida
                // saqlagan bo'lishi mumkin — ikkalasini ham tekshiramiz
                const user = await this.prisma.user.findFirst({
                    where: {
                        OR: [{ phone: withPlus }, { phone: digits }],
                    },
                });

                if (!user) {
                    await ctx.reply(
                        `❌ Bu telefon raqam bilan KiberXona akkaunti topilmadi.

Avval mobil ilovada ro'yxatdan o'ting.`,
                        this.mainMenuKeyboard(),
                    );
                    return;
                }

                await this.prisma.user.update({
                    where: { id: user.id },
                    data: {
                        isVerified: true,
                        telegramId: String(ctx.from.id),
                        verifiedAt: new Date(),
                    },
                });

                await ctx.reply(
                    `✅ Telefon raqamingiz muvaffaqiyatli tasdiqlandi.

Endi KiberXona ilovasiga qaytishingiz mumkin.`,
                    this.mainMenuKeyboard(),
                );
            } catch (err) {
                console.error("Telefon tasdiqlashda xato:", err);
                await ctx.reply(
                    "⚠️ Tasdiqlashda xatolik yuz berdi. Birozdan so'ng qaytadan urinib ko'ring.",
                    this.mainMenuKeyboard(),
                );
            }
        });
    }

    private async sendContactRequest(ctx: Context): Promise<void> {
        await ctx.reply(
            "Telefon raqamingizni tasdiqlash uchun quyidagi tugmani bosing.",
            Markup.keyboard([
                [Markup.button.contactRequest("📱 Telefon raqamni yuborish")],
            ])
                .resize()
                .oneTime(),
        );
    }

    // --------------------------------------------------------------
    // 👑 Premium holatim
    // --------------------------------------------------------------
    private registerPremiumStatusHandler(): void {
        this.bot.hears("👑 Premium holatim", async (ctx) => {
            const session = sessions.get(ctx.from.id);

            if (!session?.selectedUserId) {
                return ctx.reply(
                    "Avval premium sotib olish bo'limidan akkauntingizni bog'lang.",
                );
            }

            try {
                const user = await this.prisma.user.findUnique({
                    where: { id: session.selectedUserId },
                });

                if (!user || !user.isPremium) {
                    return ctx.reply("❌ Premium mavjud emas.");
                }

                const untilText = user.premiumUntil
                    ? user.premiumUntil.toLocaleDateString()
                    : "Noma'lum";

                await ctx.reply(`👑 Premium aktiv

📅 Tugash sanasi: ${untilText}`);
            } catch (err) {
                console.error("Premium holatini olishda xato:", err);
                await ctx.reply("⚠️ Ma'lumotni olishda xatolik yuz berdi.");
            }
        });
    }

    // --------------------------------------------------------------
    // ⭐ Premium sotib olish
    // --------------------------------------------------------------
    private registerPremiumPurchaseHandler(): void {
        this.bot.hears("⭐ Premium sotib olish", async (ctx) => {
            sessions.set(ctx.from.id, { step: "WAIT_USER" });

            await ctx.reply(`📧 Email yoki username kiriting.

Misol:

ali@gmail.com

yoki

hacker_ali`);
        });
    }

    // --------------------------------------------------------------
    // 💬 Support
    // --------------------------------------------------------------
    private registerSupportHandler(): void {
        this.bot.hears("💬 Support", async (ctx) => {
            const session: Session = sessions.get(ctx.from.id) || {};

            session.activeSupport = true;
            sessions.set(ctx.from.id, session);

            await ctx.reply(`💬 Support rejimi yoqildi.

Muammoingizni yozing.

Chiqish uchun: /close`);
        });
    }

    private registerCloseCommand(): void {
        this.bot.command("close", async (ctx) => {
            const session = sessions.get(ctx.from.id);

            if (!session) {
                return;
            }

            sessions.delete(ctx.from.id);
            await ctx.reply("✅ Support sessiyasi yopildi.");
        });
    }

    // --------------------------------------------------------------
    // Matnli xabarlar: admin javobi / support xabari / premium qidiruv
    // --------------------------------------------------------------
    private registerTextHandler(): void {
        this.bot.on("text", async (ctx) => {
            const session = sessions.get(ctx.from.id);

            // 1) ADMIN/SUPPORT userga javob yozayotgan bo'lsa
            if (this.adminReplyMap.has(ctx.from.id)) {
                await this.handleAdminReply(ctx);
                return;
            }

            // 2) Foydalanuvchi support rejimida bo'lsa
            if (session?.activeSupport) {
                await this.handleSupportMessage(ctx);
                return;
            }

            // 3) Premium uchun user qidirilayotgan bo'lsa
            if (session?.step === "WAIT_USER") {
                await this.handleUserLookup(ctx, session);
                return;
            }
        });
    }

    private async handleAdminReply(ctx: Context): Promise<void> {
        const targetUserId = this.adminReplyMap.get(ctx.from!.id);
        const text = (ctx.message as any)?.text;

        if (!targetUserId || !text) {
            return;
        }

        try {
            await this.bot.telegram.sendMessage(
                targetUserId,
                `💬 Support javobi

${text}`,
            );
            await ctx.reply("✅ Javob yuborildi.");
        } catch (e) {
            console.error("Javob yuborishda xato:", e);
            await ctx.reply("⚠️ Javobni yuborib bo'lmadi (foydalanuvchi botni bloklagan bo'lishi mumkin).");
        } finally {
            this.adminReplyMap.delete(ctx.from!.id);
        }
    }

    private async handleSupportMessage(ctx: Context): Promise<void> {
        const text = (ctx.message as any)?.text ?? "";
        const from = ctx.from!;

        for (const supportId of SUPPORT_IDS) {
            try {
                await this.bot.telegram.sendMessage(
                    supportId,
                    `🆘 Yangi support xabari

👤 @${from.username || from.first_name}
🆔 ${from.id}
✉️ ${text}`,
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    {
                                        text: "✍️ Javob berish",
                                        callback_data: `reply_${from.id}`,
                                    },
                                ],
                            ],
                        },
                    },
                );
            } catch (e) {
                console.error(`Support ID ${supportId}ga yuborishda xato:`, e);
            }
        }

        await ctx.reply("✅ Xabaringiz supportga yuborildi.");
    }

    private async handleUserLookup(ctx: Context, session: Session): Promise<void> {
        const input = ((ctx.message as any)?.text ?? "").trim();

        if (!input) {
            await ctx.reply("Iltimos, email yoki username kiriting.");
            return;
        }

        try {
            const user = await this.prisma.user.findFirst({
                where: {
                    OR: [{ email: input }, { username: input }],
                },
            });

            if (!user) {
                await ctx.reply("❌ Foydalanuvchi topilmadi.");
                return;
            }

            sessions.set(ctx.from!.id, {
                ...session,
                selectedUserId: user.id,
                emailOrUsername: input,
                step: "WAIT_PACKAGE",
            });

            await ctx.reply(`✅ Akkaunt topildi

👤 ${user.username}
📧 ${user.email}`);

            await ctx.reply(
                "Premium muddatini tanlang:",
                Markup.inlineKeyboard(
                    Object.keys(PREMIUM_PRICES).map((months) => [
                        Markup.button.callback(
                            `${months} oy — ${PREMIUM_PRICES[Number(months)]} so'm`,
                            `premium_${months}`,
                        ),
                    ]).flat(),
                ),
            );
        } catch (err) {
            console.error("Foydalanuvchini qidirishda xato:", err);
            await ctx.reply("⚠️ Qidirishda xatolik yuz berdi.");
        }
    }

    // --------------------------------------------------------------
    // Premium muddatini tanlash (premium_<months>)
    // --------------------------------------------------------------
    private registerPremiumPackageAction(): void {
        this.bot.action(/^premium_(\d+)$/, async (ctx) => {
            await ctx.answerCbQuery();

            const months = Number(ctx.match[1]);
            const session = sessions.get(ctx.from.id);

            if (!session) {
                return ctx.reply("Session topilmadi. Qaytadan boshlang: ⭐ Premium sotib olish");
            }

            const price = PREMIUM_PRICES[months];

            if (price === undefined) {
                return ctx.reply("❌ Noto'g'ri muddat tanlandi.");
            }

            session.selectedMonths = months;
            session.waitingReceipt = true;
            sessions.set(ctx.from.id, session);

            await ctx.reply(`⭐ Premium tanlandi

Muddat: ${months} oy
Narxi: ${price} so'm

${PAYMENT_CARDS}

📷 To'lov chekini yuboring.`);
        });
    }

    // --------------------------------------------------------------
    // To'lov cheki (rasm)
    // --------------------------------------------------------------
    private registerReceiptPhotoHandler(): void {
        this.bot.on("photo", async (ctx) => {
            const session = sessions.get(ctx.from.id);

            if (!session?.waitingReceipt) {
                return;
            }

            const photos = ctx.message.photo;
            const photo = photos[photos.length - 1];
            const from = ctx.from;

            let sentToAtLeastOneAdmin = false;

            for (const adminId of ADMIN_IDS) {
                try {
                    await this.bot.telegram.sendPhoto(adminId, photo.file_id, {
                        caption: `🆕 PREMIUM SO'ROVI

Telegram: @${from.username || from.first_name}
Telegram ID: ${from.id}
User: ${session.emailOrUsername}
Muddat: ${session.selectedMonths} oy`,
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    {
                                        text: "✅ Tasdiqlash",
                                        callback_data: `approve_${from.id}`,
                                    },
                                    {
                                        text: "❌ Bekor qilish",
                                        callback_data: `reject_${from.id}`,
                                    },
                                ],
                            ],
                        },
                    });
                    sentToAtLeastOneAdmin = true;
                } catch (e) {
                    console.error(`Admin ${adminId}ga chek yuborishda xato:`, e);
                }
            }

            if (!sentToAtLeastOneAdmin) {
                await ctx.reply(
                    "⚠️ Chekni administratorlarga yuborib bo'lmadi. Iltimos, keyinroq qayta urinib ko'ring yoki supportga yozing.",
                );
                return;
            }

            await ctx.reply(
                "✅ Chek qabul qilindi.\n\nAdministrator tekshirayotganidan so'ng premium aktivlashtiriladi.",
            );

            session.waitingReceipt = false;
            sessions.set(ctx.from.id, session);
        });
    }

    // --------------------------------------------------------------
    // ✅ Tasdiqlash (approve_<telegramId>) — faqat admin/support
    // --------------------------------------------------------------
    private registerApproveAction(): void {
        this.bot.action(/^approve_(\d+)$/, async (ctx) => {
            await ctx.answerCbQuery();

            if (!isStaff(ctx.from.id)) {
                return ctx.reply("⛔ Sizda bu amalni bajarish huquqi yo'q.");
            }

            const telegramId = Number(ctx.match[1]);
            const session = sessions.get(telegramId);

            if (!session?.selectedUserId || !session.selectedMonths) {
                return ctx.reply("Session topilmadi yoki muddati tugagan.");
            }

            try {
                const user = await this.prisma.user.findUnique({
                    where: { id: session.selectedUserId },
                });

                if (!user) {
                    return ctx.reply("User topilmadi.");
                }

                // Agar user hozir ham premium bo'lsa, muddatga qo'shib boramiz,
                // aks holda bugungi kundan boshlab hisoblaymiz
                const base =
                    user.isPremium && user.premiumUntil && user.premiumUntil > new Date()
                        ? new Date(user.premiumUntil)
                        : new Date();

                base.setMonth(base.getMonth() + session.selectedMonths);

                await this.prisma.user.update({
                    where: { id: user.id },
                    data: {
                        isPremium: true,
                        premiumUntil: base,
                    },
                });

                try {
                    await this.bot.telegram.sendMessage(
                        telegramId,
                        `🎉 Premium muvaffaqiyatli aktivlashtirildi.

📅 Tugash sanasi: ${base.toLocaleDateString()}`,
                    );
                } catch (e) {
                    console.error("Userga xabar yuborishda xato:", e);
                }

                await ctx.reply("✅ Premium berildi.");
                sessions.delete(telegramId);
            } catch (err) {
                console.error("Premiumni tasdiqlashda xato:", err);
                await ctx.reply("⚠️ Tasdiqlashda xatolik yuz berdi.");
            }
        });
    }

    // --------------------------------------------------------------
    // ❌ Bekor qilish (reject_<telegramId>) — faqat admin/support
    // --------------------------------------------------------------
    private registerRejectAction(): void {
        this.bot.action(/^reject_(\d+)$/, async (ctx) => {
            await ctx.answerCbQuery();

            if (!isStaff(ctx.from.id)) {
                return ctx.reply("⛔ Sizda bu amalni bajarish huquqi yo'q.");
            }

            const telegramId = Number(ctx.match[1]);
            const session = sessions.get(telegramId);

            try {
                await this.bot.telegram.sendMessage(
                    telegramId,
                    "❌ To'lovingiz tasdiqlanmadi. Iltimos, chekni tekshirib qaytadan yuboring yoki supportga yozing.",
                );
            } catch (e) {
                console.error("Userga rad javobini yuborishda xato:", e);
            }

            if (session) {
                session.waitingReceipt = false;
                sessions.set(telegramId, session);
            }

            await ctx.reply("❌ So'rov bekor qilindi.");
        });
    }

    // --------------------------------------------------------------
    // ✍️ Javob berish (reply_<userId>) — faqat admin/support
    // --------------------------------------------------------------
    private registerReplyAction(): void {
        this.bot.action(/^reply_(\d+)$/, async (ctx) => {
            await ctx.answerCbQuery();

            if (!isStaff(ctx.from.id)) {
                return ctx.reply("⛔ Sizda bu amalni bajarish huquqi yo'q.");
            }

            const userTelegramId = Number(ctx.match[1]);
            this.adminReplyMap.set(ctx.from.id, userTelegramId);

            await ctx.reply("✍️ Userga yuboriladigan javobni yozing.");
        });
    }
}