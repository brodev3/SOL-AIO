const { PublicKey, LAMPORTS_PER_SOL, Transaction, SystemProgram, Message } = require('@solana/web3.js');
const { getMint } = require('@solana/spl-token');
const BN = require('bn.js');
const readline = require('readline');
const logger = require('./utils/logger');
const Wallet = require('./wallet');
const config = require('./config/config');
const utils = require('./utils/utils');

class Sender {
    constructor() {
        this.receivers = [];
    }

    async convertToTokenAmount(amount, mint, connection) {
        const mintInfo = await getMint(connection, mint);
        return new BN(Math.floor(amount * Math.pow(10, mintInfo.decimals)));
    }

    async loadReceivers() {
        try {
            const addresses = await utils.readCSVToArray('receivers.csv');
            for (const address of addresses) {
                try {
                    new PublicKey(address);
                    this.receivers.push(address);
                } catch (e) {
                    logger.error(`Invalid address: ${e.stack}`);
                }
            }
            
            if (this.receivers.length === 0) {
                throw new Error('No valid addresses found');
            }
            
            logger.info(`Loaded ${this.receivers.length} receiver addresses`);
        } catch (error) {
            logger.error(`Error loading receivers: ${error.stack}`);
            throw error;
        }
    }

    async loadWallets() {
        try {
            const privateKeys = await utils.readCSVToArray('w.csv');
            return privateKeys.map(privateKey => {
                if (config.DECRYPT) {
                    privateKey = utils.decrypt(privateKey, config.MESSAGE);
                }
                if (typeof privateKey !== 'string' || !privateKey.trim()) {
                    throw new Error('Invalid private key format');
                }
                return new Wallet(privateKey);
            });
        } catch (error) {
            logger.error(`Error loading wallets: ${error.stack}`);
            throw error;
        }
    }

    async startDistribution() {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        try {
            await this.loadReceivers();
            const wallets = await this.loadWallets();

            const tokenType = await this.question(rl, 'Select token type (1 - SOL, 2 - SPL): ');
            let mint = null;
            let decimals = 0;
            if (tokenType === '2') {
                const mintAddress = await this.question(rl, 'Enter SPL token address: ');
                mint = new PublicKey(mintAddress);
                try {
                    const mintInfo = await getMint(wallets[0].connection, mint);
                    decimals = mintInfo.decimals;
                } catch (e) {
                    throw new Error('Invalid token address');
                }
            }

            const amountType = await this.question(rl, 'Select amount type (1 - fixed, 2 - percentage of balance): ');
            const amount = parseFloat(await this.question(rl, `Enter ${amountType === '1' ? 'amount' : 'percentage'}: `));
            if (isNaN(amount) || amount <= 0 || (amountType === '2' && amount > 100)) {
                throw new Error('Invalid amount');
            }

            // Confirmation before starting distribution
            const confirm = await this.question(rl, 'Confirm sending for all wallets (y/n): ');
            if (confirm.toLowerCase() !== 'y') {
                throw new Error('Cancelled by user');
            }

            logger.info(`\nDistribution parameters:
- Token type: ${tokenType === '1' ? 'SOL' : 'SPL'}
${tokenType === '2' ? `- Token address: ${mint.toBase58()}\n` : ''}- Number of receivers: ${this.receivers.length}
- Amount: ${amount}${amountType === '2' ? '%' : (tokenType === '1' ? ' SOL' : ' tokens')}
- Max execution time: ${config.MAX_TIME} seconds\n`);

            for (const wallet of wallets) {
                let lamports;
                let actualAmount;
                try {
                    if (mint) {
                        const balance = await wallet.splBalance(mint);
                        if (!balance || new BN(balance).isZero()) {
                            logger.warn(`${wallet.keyPair.publicKey.toBase58()} | Insufficient SPL token balance`);
                            continue; // Skip wallet
                        }
                        lamports = amountType === '2' ?
                            new BN(balance).mul(new BN(amount)).div(new BN(100)) :
                            await this.convertToTokenAmount(amount, mint, wallet.connection);
                        const wholePart = lamports.div(new BN(10).pow(new BN(decimals)));
                        const fractionalPart = lamports.mod(new BN(10).pow(new BN(decimals))).toString().padStart(decimals, '0');
                        actualAmount = `${wholePart.toString()}.${fractionalPart}`;
                    } else {
                        const balance = await wallet.solBalance();
                        if (!balance || new BN(balance).isZero()) {
                            logger.warn(`${wallet.keyPair.publicKey.toBase58()} | Insufficient SOL balance`);
                            continue; // Skip wallet
                        }
                        if (amountType === '2') {
                            const transaction = new Transaction();
                            transaction.add(SystemProgram.transfer({
                                fromPubkey: wallet.keyPair.publicKey,
                                toPubkey: wallet.keyPair.publicKey,
                                lamports: 0,
                            }));

                            const latestBlockhash = await wallet.connection.getLatestBlockhash();
                            transaction.recentBlockhash = latestBlockhash.blockhash;
                            transaction.feePayer = wallet.keyPair.publicKey;

                            const message = transaction.compileMessage();
                            const fees = await wallet.connection.getFeeForMessage(message);
                            lamports = new BN(balance).mul(new BN(amount)).div(new BN(100));
                            if (amount === 100) {
                                lamports = lamports.sub(new BN(fees.value));
                            }
                        } else {
                            lamports = new BN(amount * LAMPORTS_PER_SOL);
                        }
                        const wholePart = lamports.div(new BN(LAMPORTS_PER_SOL));
                        const fractionalPart = lamports.mod(new BN(LAMPORTS_PER_SOL)).toString().padStart(9, '0');
                        actualAmount = `${wholePart.toString()}.${fractionalPart}`;
                    }

                    const selectedReceivers = this.shuffleArray(this.receivers);
                    const startTime = Date.now();

                    const promises = selectedReceivers.map((receiver, index) => {
                        const delay = Math.floor(Math.random() * config.MAX_TIME * 1000);
                        
                        return new Promise(resolve => {
                            setTimeout(async () => {
                                try {
                                    const currentBalance = mint ? 
                                        await wallet.splBalance(mint) : 
                                        await wallet.solBalance();

                                    if (!currentBalance || new BN(currentBalance).lt(lamports)) {
                                        throw new Error(`${wallet.keyPair.publicKey.toBase58()} | Insufficient ${mint ? 'tokens' : 'SOL'} for sending`);
                                    }

                                    await wallet.transfer(receiver, lamports, mint);
                                    const timeSpent = Math.floor((Date.now() - startTime) / 1000);
                                    const amountStr = mint ? 
                                        `${actualAmount} tokens` : 
                                        `${actualAmount} SOL`;
                                    logger.success(`${wallet.keyPair.publicKey.toBase58()} => ${receiver} Sent ${amountStr}`);
                                } catch (error) {
                                    logger.fail(`${wallet.keyPair.publicKey.toBase58()} | ${error.stack}`);
                                }
                                resolve();
                            }, delay);
                        });
                    });

                    await Promise.all(promises);
                    logger.info(`${wallet.keyPair.publicKey.toBase58()} | All transactions completed`);
                } catch (error) {
                    logger.error(`${wallet.keyPair.publicKey.toBase58()} | ${error.stack}`);
                }
            }

        } catch (error) {
            logger.error(`${error.stack}`);
        } finally {
            rl.close();
        }
    }

    async question(rl, query) {
        return new Promise(resolve => rl.question(query, resolve));
    }

    shuffleArray(array) {
        const newArray = [...array];
        for (let i = newArray.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
        }
        return newArray;
    }
}

const sender = new Sender();
sender.startDistribution(); 