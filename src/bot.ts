import "dotenv/config";

import { TelegramService } from "./telegram.service";

async function bootstrap() {
    const bot =
        new TelegramService();

    await bot.start();
}

bootstrap();