const { Connection, Keypair, clusterApiUrl, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { createMint, getOrCreateAssociatedTokenAccount, mintTo } = require('@solana/spl-token');
const fs = require('fs');
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Функция для запроса ввода
function question(query) {
    return new Promise(resolve => {
        rl.question(query, resolve);
    });
}

async function createToken() {
    try {
        // Подключение к devnet
        console.log('🔌 Подключение к Solana Devnet...');
        const connection = new Connection(clusterApiUrl('devnet'), 'confirmed');
        
        // Создаем или загружаем кошелек
        let wallet;
        const walletFile = 'wallet_devnet.json';
        
        if (fs.existsSync(walletFile)) {
            // Загружаем существующий кошелек
            const secretKeyString = fs.readFileSync(walletFile, 'utf8');
            const secretKey = Uint8Array.from(JSON.parse(secretKeyString));
            wallet = Keypair.fromSecretKey(secretKey);
            console.log(`📂 Загружен существующий кошелек: ${wallet.publicKey.toString()}`);
        } else {
            // Создаем новый кошелек
            wallet = Keypair.generate();
            fs.writeFileSync(walletFile, JSON.stringify(Array.from(wallet.secretKey)));
            console.log(`🔑 Создан новый кошелек: ${wallet.publicKey.toString()}`);
            console.log(`⚠️ ВАЖНО: Вам нужно получить SOL для этого кошелька!`);
            console.log(`   Посетите: https://faucet.solana.com/ или https://solfaucet.com/`);
            console.log(`   И отправьте на адрес: ${wallet.publicKey.toString()}`);
            
            const solReceived = await question('\nПолучили SOL? (да/нет): ');
            if (solReceived.toLowerCase() !== 'да' && solReceived.toLowerCase() !== 'yes') {
                console.log('Получите SOL и запустите скрипт снова');
                return;
            }
        }
        
        // Проверяем баланс кошелька
        const balance = await connection.getBalance(wallet.publicKey);
        console.log(`💰 Текущий баланс: ${balance / LAMPORTS_PER_SOL} SOL`);
        
        if (balance < 0.05 * LAMPORTS_PER_SOL) {
            console.error('❌ Недостаточно SOL для создания токена (нужно минимум 0.05 SOL)');
            console.log('Получите SOL и запустите скрипт снова');
            return;
        }
        
        // Запрашиваем данные токена
        const tokenName = await question('Введите название токена: ');
        const tokenSymbol = await question('Введите символ токена: ');
        const decimals = parseInt(await question('Введите количество десятичных знаков (обычно 9): '));
        const initialSupply = parseFloat(await question('Введите начальный supply токена: '));
        
        console.log(`\n🪙 Создаем токен ${tokenName} (${tokenSymbol})...`);
        
        // Создаем минт токена
        const mint = await createMint(
            connection,
            wallet,          // payer
            wallet.publicKey, // mintAuthority
            wallet.publicKey, // freezeAuthority
            decimals
        );
        
        console.log(`✅ Токен создан! Адрес: ${mint.toString()}`);
        
        // Создаем токен-аккаунт для владельца
        console.log('👛 Создаем токен-аккаунт...');
        const tokenAccount = await getOrCreateAssociatedTokenAccount(
            connection,
            wallet,
            mint,
            wallet.publicKey
        );
        
        console.log(`✅ Токен-аккаунт создан: ${tokenAccount.address.toString()}`);
        
        // Минтим токены на аккаунт
        console.log(`💵 Минтим ${initialSupply} токенов...`);
        const mintAmount = BigInt(Math.floor(initialSupply * (10 ** decimals)));
        
        await mintTo(
            connection,
            wallet,
            mint,
            tokenAccount.address,
            wallet.publicKey,
            mintAmount
        );
        
        console.log(`✅ Токены успешно созданы!`);
        
        // Выводим информацию
        console.log('\n=== ИНФОРМАЦИЯ О ТОКЕНЕ ===');
        console.log(`Название: ${tokenName}`);
        console.log(`Символ: ${tokenSymbol}`);
        console.log(`Адрес токена: ${mint.toString()}`);
        console.log(`Десятичные знаки: ${decimals}`);
        console.log(`Начальный supply: ${initialSupply}`);
        console.log(`Адрес кошелька создателя: ${wallet.publicKey.toString()}`);
        console.log(`Сеть: devnet`);
        console.log('\n=== ДАННЫЕ ДЛЯ ПРОВЕРКИ ===');
        console.log(`Ссылка на токен: https://explorer.solana.com/address/${mint.toString()}?cluster=devnet`);
        console.log(`Ссылка на кошелек: https://explorer.solana.com/address/${wallet.publicKey.toString()}?cluster=devnet`);
        
    } catch (error) {
        console.error('❌ Произошла ошибка:', error);
    } finally {
        rl.close();
    }
}

createToken().catch(console.error);