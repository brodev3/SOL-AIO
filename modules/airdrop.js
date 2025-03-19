const { Connection, Keypair, PublicKey, clusterApiUrl, LAMPORTS_PER_SOL, Transaction } = require('@solana/web3.js');
const { getOrCreateAssociatedTokenAccount, createAssociatedTokenAccountInstruction, getAssociatedTokenAddress, createTransferInstruction, getMint } = require('@solana/spl-token');
const fs = require('fs');
const readline = require('readline');
const path = require('path');
const log = require('../utils/logger');
const bs58 = require('bs58').default;

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function question(query) {
    return new Promise(resolve => {
        rl.question(query, resolve);
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Функция для безопасной записи в файл с созданием директории
function safeWriteFile(filePath, data) {
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, data);
        return true;
    } catch (error) {
        log.error(`Ошибка при записи в файл ${filePath}: ${error.message}`);
        return false;
    }
}

// Функция для обработки с ограничением параллелизма
async function processWithConcurrencyLimit(items, concurrencyLimit, processor) {
    const results = [];
    const running = new Set();
    
    for (const item of items) {
        const promise = (async () => {
            try {
                return await processor(item);
            } catch (error) {
                // Обрабатываем ошибку, но не позволяем ей прервать весь процесс
                log.error(`Критическая ошибка при обработке ${item}: ${error.message}`);
                return { item, success: false, error: error.message };
            } finally {
                running.delete(promise);
            }
        })();
        
        running.add(promise);
        results.push(promise);
        
        if (running.size >= concurrencyLimit) {
            await Promise.race(running);
        }
    }
    
    return Promise.all(results);
}

// Функция для создания и отправки транзакции с обработкой истекшего блокхеша
async function createAndSendTransaction(connection, wallet, transaction, attempt) {
    // Получаем новый блокхеш для каждой попытки
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = wallet.publicKey;
    
    log.info(`🔄 [Попытка ${attempt}] Симуляция транзакции с блокхешем: ${blockhash.substring(0, 8)}...`);
    
    // Сначала симулируем транзакцию
    const simulation = await connection.simulateTransaction(transaction);
    
    if (simulation.value.err) {
        const errorMsg = JSON.stringify(simulation.value.err);
        log.error(`⚠️ Симуляция не удалась: ${errorMsg}`);
        throw new Error(`Simulation failed: ${errorMsg}`);
    }
    
    log.info(`✅ Симуляция успешна`);
    log.info(`🔄 Отправка транзакции...`);
    
    // Подписываем транзакцию
    transaction.sign(wallet);
    
    // Отправляем транзакцию
    const txId = await connection.sendRawTransaction(transaction.serialize());
    
    log.info(`⏳ Ожидание подтверждения транзакции (TX ID: ${txId})...`);
    
    try {
        // Ожидаем подтверждения
        await connection.confirmTransaction({
            signature: txId,
            blockhash: blockhash,
            lastValidBlockHeight: lastValidBlockHeight
        });
        
        return { txId, success: true };
    } catch (error) {
        // Проверяем, связана ли ошибка с истекшим блокхешем
        if (error.message.includes('blockhash not found') || 
            error.message.includes('block height exceeded') || 
            error.message.includes('invalid blockhash') ||
            error.message.includes('timeout')) {
            
            log.warn(`⚠️ Блокхеш устарел или тайм-аут подтверждения. Будет получен новый блокхеш.`);
            throw new Error('BLOCKHASH_EXPIRED');
        }
        
        throw error;
    }
}

async function sendTokensToHolders() {
    try {
        log.info('📬 Запуск программы рассылки токенов холдерам NFT\n');
        
        // Создаем директории для логов и результатов
        const logsDir = path.join(__dirname, '../logs');
        const resultsDir = path.join(__dirname, '../results');
        
        for (const dir of [logsDir, resultsDir]) {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        }
        
        // Создаем файлы для успешных и неудачных отправок
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const successFilePath = path.join(resultsDir, `success_${timestamp}.txt`);
        const failureFilePath = path.join(resultsDir, `failure_${timestamp}.txt`);
        
        // Создаем пустые файлы
        fs.writeFileSync(successFilePath, '');
        fs.writeFileSync(failureFilePath, '');
        
        log.info(`📝 Результаты будут записаны в файлы:\n - ${successFilePath}\n - ${failureFilePath}`);
        
        if (!fs.existsSync('holders.json')) {
            log.error('❌ Файл holders.json не найден. Сначала получите список холдеров.');
            return;
        }
        
        // Читаем и парсим исходный файл холдеров
        let holdersData = JSON.parse(fs.readFileSync('holders.json', 'utf8'));
        let holderAddresses = Object.keys(holdersData);
        
        if (holderAddresses.length === 0) {
            log.error('❌ Список холдеров пуст.');
            return;
        }
        
        log.info(`📋 Загружено ${holderAddresses.length} холдеров.`);
        
        const defaultRPC = clusterApiUrl('devnet');
        const customRPC = await question(`Введите RPC URL (или нажмите Enter для использования devnet): `);
        const rpcUrl = customRPC || defaultRPC;
        
        log.info(`🔌 Подключение к ${customRPC ? 'пользовательскому RPC' : 'Solana Devnet'}...`);
        const connection = new Connection(rpcUrl, 'confirmed');
        
        try {
            const version = await connection.getVersion();
            log.info(`✅ Подключено к Solana ${version['solana-core']}`);
        } catch (error) {
            log.error('❌ Не удалось подключиться к RPC. Проверьте URL и доступность сервера.');
            return;
        }
        
        let wallet;
        const walletFile = 'modules/sender.json';
        
        if (fs.existsSync(walletFile)) {
            try {
                const jsonData = JSON.parse(fs.readFileSync(walletFile, 'utf8'));
                const privateKeyBase58 = jsonData.sender;
                if (!privateKeyBase58) {
                    log.error('❌ В файле sender.json не найдено поле "sender" с приватным ключом');
                    return;
                }
                const secretKey = bs58.decode(privateKeyBase58);
                wallet = Keypair.fromSecretKey(secretKey);
                log.info(`📂 Загружен кошелек отправителя: ${wallet.publicKey.toString()}`);
            } catch (error) {
                log.error(`❌ Ошибка при чтении приватного ключа: ${error.message}`);
                return;
            }
        } else {
            log.error('❌ Файл кошелька не найден. Создайте файл modules/sender.json');
            log.error('   Формат файла: {"sender": "base58_приватный_ключ"}');
            return;
        }
        
        const solBalance = await connection.getBalance(wallet.publicKey);
        log.info(`💰 Баланс SOL: ${solBalance / LAMPORTS_PER_SOL} SOL`);
        
        const estimatedCost = 0.00003 * LAMPORTS_PER_SOL * holderAddresses.length;
        log.info(`💰 Примерная стоимость всех транзакций: ${estimatedCost / LAMPORTS_PER_SOL} SOL`);
        
        if (solBalance < estimatedCost) {
            log.error(`❌ Недостаточно SOL для транзакций. Необходимо минимум ${estimatedCost / LAMPORTS_PER_SOL} SOL.`);
            const forceContinue = await question('Продолжить, несмотря на недостаточный баланс? (да/нет): ');
            if (forceContinue.toLowerCase() !== 'да' && forceContinue.toLowerCase() !== 'yes') {
                return;
            }
        }
        
        const tokenAddressInput = await question('Введите адрес токена для рассылки: ');
        let tokenAddress;
        
        try {
            tokenAddress = new PublicKey(tokenAddressInput);
        } catch (error) {
            log.error('❌ Неверный адрес токена.');
            return;
        }
        
        let tokenInfo;
        try {
            tokenInfo = await getMint(connection, tokenAddress);
            log.info(`✅ Токен найден. Десятичные знаки: ${tokenInfo.decimals}`);
        } catch (error) {
            log.error('❌ Не удалось получить информацию о токене. Проверьте адрес.');
            return;
        }
        
        let senderTokenAccount;
        try {
            senderTokenAccount = await getOrCreateAssociatedTokenAccount(
                connection,
                wallet,
                tokenAddress,
                wallet.publicKey
            );
            
            log.info(`✅ Токен-аккаунт отправителя: ${senderTokenAccount.address.toString()}`);
        } catch (error) {
            log.error('❌ Не удалось получить токен-аккаунт отправителя:', error.message);
            return;
        }
        
        log.info(`💰 Баланс токенов: ${parseInt(senderTokenAccount.amount) / (10 ** tokenInfo.decimals)}`);
        
        const totalHolders = holderAddresses.length;
        
        const multiplierStr = await question('Введите множитель (на сколько умножить количество NFT каждого холдера): ');
        const multiplier = parseFloat(multiplierStr);
        
        if (isNaN(multiplier) || multiplier <= 0) {
            log.error('❌ Неверный множитель. Должно быть положительное число.');
            return;
        }
        
        // Запрашиваем уровень параллелизма
        const concurrencyStr = await question('Введите количество одновременных транзакций (рекомендуется 5-10): ');
        const concurrencyLimit = parseInt(concurrencyStr) || 5; // По умолчанию 5 одновременных транзакций
        
        let totalTokensNeeded = 0;
        for (const holder of holderAddresses) {
            const nftCount = holdersData[holder];
            const tokensToSend = nftCount * multiplier;
            totalTokensNeeded += tokensToSend;
        }
        
        const totalTokensNeededWithDecimals = totalTokensNeeded * (10 ** tokenInfo.decimals);
        
        log.info(`\n=== ИНФОРМАЦИЯ О РАССЫЛКЕ ===`);
        log.info(`Всего холдеров: ${totalHolders}`);
        log.info(`Множитель: ${multiplier}`);
        log.info(`Всего будет отправлено: ${totalTokensNeeded} токенов`);
        log.info(`Одновременных транзакций: ${concurrencyLimit}`);
        
        if (parseInt(senderTokenAccount.amount) < totalTokensNeededWithDecimals) {
            log.error(`❌ Недостаточно токенов. Необходимо ${totalTokensNeeded}, доступно ${parseInt(senderTokenAccount.amount) / (10 ** tokenInfo.decimals)}`);
            const forceContinue = await question('Продолжить, несмотря на недостаточный баланс токенов? (да/нет): ');
            if (forceContinue.toLowerCase() !== 'да' && forceContinue.toLowerCase() !== 'yes') {
                return;
            }
        }
        
        const confirmation = await question(`\nНачать рассылку ${totalTokensNeeded} токенов для ${totalHolders} холдеров? (да/нет): `);
        
        if (confirmation.toLowerCase() !== 'да' && confirmation.toLowerCase() !== 'yes') {
            log.info('Операция отменена.');
            return;
        }
        
        const maxRetries = 5;
        const batchSize = 50;
        
        // Используем Set для отслеживания успешных и неудачных адресов
        const successfulAddresses = new Set();
        const failedAddresses = new Set();
        
        log.info('\n=== НАЧИНАЕМ РАССЫЛКУ ===');
        
        // Засекаем время начала рассылки
        const startTime = Date.now();
        let processedCount = 0;
        
        for (let i = 0; i < holderAddresses.length; i += batchSize) {
            const batch = holderAddresses.slice(i, i + batchSize);
            
            log.info(`\nОбработка группы ${i/batchSize + 1}/${Math.ceil(holderAddresses.length/batchSize)}...`);
            
            // Обновляем состояние оставшихся холдеров (удаляем уже обработанные)
            const remainingHolders = { ...holdersData };
            successfulAddresses.forEach(address => delete remainingHolders[address]);
            
            // Сохраняем обновленный файл холдеров в режиме онлайн
            safeWriteFile('holders_remaining.json', JSON.stringify(remainingHolders, null, 2));
            
            // Обрабатываем пакет с контролем параллелизма
            await processWithConcurrencyLimit(batch, concurrencyLimit, async (holderAddress) => {
                // Если адрес уже успешно обработан, пропускаем его
                if (successfulAddresses.has(holderAddress)) {
                    return { holderAddress, success: true, skipped: true };
                }
                
                const nftCount = holdersData[holderAddress];
                const tokensToSend = nftCount * multiplier;
                const tokensToSendWithDecimals = Math.floor(tokensToSend * (10 ** tokenInfo.decimals));
                
                log.info(`\n📤 Отправка ${tokensToSend} токенов на ${holderAddress} (${nftCount} NFT)`);
                
                let success = false;
                let attempts = 0;
                let txId = null;
                let lastError = null;
                
                while (!success && attempts < maxRetries) {
                    attempts++;
                    try {
                        let recipientPublicKey;
                        try {
                            recipientPublicKey = new PublicKey(holderAddress);
                        } catch (error) {
                            log.error(`❌ Неверный адрес ${holderAddress}`);
                            throw new Error(`Invalid address: ${holderAddress}`);
                        }
                        
                        const recipientTokenAddress = await getAssociatedTokenAddress(
                            tokenAddress,
                            recipientPublicKey
                        );
                        
                        const recipientTokenAccount = await connection.getAccountInfo(recipientTokenAddress);
                        
                        if (!recipientTokenAccount) {
                            log.info(`⚠️ [${holderAddress}] Токен-аккаунт не существует, создаем...`);
                        }
                        
                        // Создаем транзакцию без блокхеша - он будет добавлен в функции createAndSendTransaction
                        const transaction = new Transaction();
                        
                        if (!recipientTokenAccount) {
                            transaction.add(
                                createAssociatedTokenAccountInstruction(
                                    wallet.publicKey,         // payer
                                    recipientTokenAddress,    // associatedToken
                                    recipientPublicKey,       // owner
                                    tokenAddress              // mint
                                )
                            );
                        }
                        
                        transaction.add(
                            createTransferInstruction(
                                senderTokenAccount.address,   // source
                                recipientTokenAddress,        // destination
                                wallet.publicKey,             // owner
                                BigInt(tokensToSendWithDecimals)
                            )
                        );
                        
                        log.info(`🔄 [${holderAddress}] Попытка ${attempts}/${maxRetries} отправки транзакции...`);
                        
                        // Используем функцию с поддержкой обработки истекшего блокхеша
                        const result = await createAndSendTransaction(connection, wallet, transaction, attempts);
                        txId = result.txId;
                        
                        log.info(`✅ [${holderAddress}] Транзакция подтверждена! TX ID: ${txId}`);
                        log.info(`🔗 [${holderAddress}] https://explorer.solana.com/tx/${txId}?cluster=${rpcUrl.includes('mainnet') ? 'mainnet' : 'devnet'}`);
                        
                        success = true;
                        
                        // Добавляем адрес в успешные и удаляем из холдеров
                        successfulAddresses.add(holderAddress);
                        
                        // Записываем в файл успешных транзакций
                        fs.appendFileSync(successFilePath, `${holderAddress},${nftCount},${tokensToSend},${txId},${new Date().toISOString()}\n`);
                        
                        // Обновляем счетчик
                        processedCount++;
                        
                    } catch (error) {
                        lastError = error;
                        
                        // Если ошибка связана с истекшим блокхешем, просто попробуем еще раз без увеличения счетчика попыток
                        if (error.message === 'BLOCKHASH_EXPIRED') {
                            log.warn(`⚠️ [${holderAddress}] Блокхеш истек, повторная попытка с новым блокхешем...`);
                            attempts--; // Не считаем эту попытку
                            await sleep(500); // Небольшая пауза перед повторной попыткой
                            continue;
                        }
                        
                        log.error(`❌ [${holderAddress}] Ошибка при отправке (попытка ${attempts}): ${error.message}`);
                        
                        if (attempts >= maxRetries) {
                            // Добавляем адрес в неудачные
                            failedAddresses.add(holderAddress);
                            
                            // Записываем в файл неудачных транзакций
                            fs.appendFileSync(failureFilePath, `${holderAddress},${nftCount},${tokensToSend},${error.message},${new Date().toISOString()}\n`);
                        }
                        
                        if (attempts < maxRetries) {
                            const delay = 2000 * attempts;
                            log.info(`⏳ [${holderAddress}] Ожидаем ${delay/1000} секунд перед следующей попыткой...`);
                            await sleep(delay);
                        }
                    }
                }
                
                return { holderAddress, success, error: success ? null : lastError?.message };
            }).catch(error => {
                // Даже если processWithConcurrencyLimit выбросит ошибку, мы её перехватим
                log.error(`Ошибка в пакетной обработке: ${error.message}`);
                return [];
            });
            
            // Выводим текущий прогресс
            log.info(`\n--- ТЕКУЩИЙ ПРОГРЕСС ---`);
            log.info(`✅ Успешно отправлено: ${successfulAddresses.size}`);
            log.info(`❌ Не удалось отправить: ${failedAddresses.size}`);
            log.info(`⏳ Осталось обработать: ${holderAddresses.length - processedCount}`);
            
            // Делаем небольшую паузу между пакетами
            if (i + batchSize < holderAddresses.length) {
                log.info(`⏳ Пауза между группами (3 секунды)...`);
                await sleep(3000);
            }
        }
        
        // Вычисляем время выполнения
        const endTime = Date.now();
        const executionTimeMinutes = Math.floor((endTime - startTime) / 60000);
        const executionTimeSeconds = Math.floor(((endTime - startTime) % 60000) / 1000);
        
        log.info('\n=== ИТОГИ РАССЫЛКИ ===');
        log.info(`✅ Успешно отправлено: ${successfulAddresses.size} / ${holderAddresses.length}`);
        log.info(`❌ Не удалось отправить: ${failedAddresses.size} / ${holderAddresses.length}`);
        log.info(`⏱️ Время выполнения: ${executionTimeMinutes} мин ${executionTimeSeconds} сек`);
        log.info(`📁 Результаты сохранены в файлах:`);
        log.info(` - ${successFilePath}`);
        log.info(` - ${failureFilePath}`);
        
        // Создаем файл с неудачными адресами для повторной отправки
        if (failedAddresses.size > 0) {
            const failureHolders = {};
            for (const address of failedAddresses) {
                failureHolders[address] = holdersData[address];
            }
            
            fs.writeFileSync('holders_retry.json', JSON.stringify(failureHolders, null, 2));
            log.info('\n📋 Создан файл holders_retry.json с неудачными адресами.');
            
            const retryFailures = await question('\nХотите повторить отправку для неудачных адресов? (да/нет): ');
            
            if (retryFailures.toLowerCase() === 'да' || retryFailures.toLowerCase() === 'yes') {
                // Копируем неудачные адреса в holders.json для повторной отправки
                fs.writeFileSync('holders.json', JSON.stringify(failureHolders, null, 2));
                log.info('Файл holders.json обновлен неудачными адресами. Запустите скрипт снова.');
            }
        } else {
            log.info('\n🎉 Все транзакции успешно выполнены!');
        }
        
    } catch (error) {
        log.error('❌ Произошла критическая ошибка:', error);
        // Даже при критической ошибке, программа не завершается
    } finally {
        rl.close();
    }
}

module.exports = sendTokensToHolders;

// Если файл запущен напрямую (не импортирован как модуль)
if (require.main === module) {
    sendTokensToHolders().catch(error => {
        log.error('Неперехваченная ошибка:', error);
        // Не используем process.exit(1), чтобы не завершать программу жестко
    });
}