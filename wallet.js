const { Keypair, Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getAssociatedTokenAddress, getAccount, createTransferInstruction, createAssociatedTokenAccountInstruction } = require('@solana/spl-token');
const config = require('./config/config');
const bs58 = require('bs58').default;
const logger = require('./utils/logger');

const connection = new Connection(config.RPC_ENDPOINT, 'finalized');

class Wallet {
    constructor(privateKeyString) {
        const secretKey = new Uint8Array(bs58.decode(privateKeyString));
        this.keyPair = Keypair.fromSecretKey(secretKey);
        this.connection = new Connection(config.RPC_ENDPOINT, 'finalized');
    };

    async splBalance(mint) {
        mint = new PublicKey(mint);
        const userInTokenATA = await getAssociatedTokenAddress(mint, this.keyPair.publicKey);
        let inTokenAccountInfo;
        try {
            inTokenAccountInfo = await getAccount(this.connection, userInTokenATA);
        } catch (err) {
            // console.error(`Нет аккаунта для токена ${mint.toBase58()} у пользователя ${this.keyPair.publicKey.toBase58()}`);
            return false;
        }

        return inTokenAccountInfo.amount;
    };

    async solBalance() {
        return await this.connection.getBalance(this.keyPair.publicKey);
    };

    async simulateTransaction(transaction) {
        let retries = 0;
        while (retries < config.MAX_RETRIES) {
            try {
                const simulation = await this.connection.simulateTransaction(transaction);
                if (simulation.value.err) {
                    logger.error(`${this.keyPair.publicKey.toBase58()} | ${error.stack}`);
                    throw error;
                }
                return simulation;
            } catch (error) {
                retries++;
                if (retries === config.MAX_RETRIES) {
                    logger.error(`${this.keyPair.publicKey.toBase58()} | ${error.stack}`);
                    throw error;
                }
                await new Promise(resolve => setTimeout(resolve, 500 * retries));
            }
        }
    }

    async sendAndConfirmTransaction(transaction) {
        let retries = 0;
        while (retries < config.MAX_RETRIES) {
            try {
                const latestBlockhash = await this.connection.getLatestBlockhash();
                transaction.recentBlockhash = latestBlockhash.blockhash;
                transaction.feePayer = this.keyPair.publicKey;

                const signature = await this.connection.sendTransaction(transaction, [this.keyPair]);
                await this.connection.confirmTransaction({
                    signature,
                    blockhash: latestBlockhash.blockhash,
                    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
                });
                return signature;
            } catch (error) {
                retries++;
                if (retries === config.MAX_RETRIES) {
                    logger.error(`${this.keyPair.publicKey.toBase58()} | ${error.stack}`);
                    throw error;
                }
                await new Promise(resolve => setTimeout(resolve, 500 * retries));
            }
        }
    }

    async transfer(recipient, lamports, mint = null) {
        recipient = new PublicKey(recipient);
        let transaction = new Transaction();

        try {
            if (mint) {
                mint = new PublicKey(mint);
                const senderATA = await getAssociatedTokenAddress(mint, this.keyPair.publicKey);
                const recipientATA = await getAssociatedTokenAddress(mint, recipient);

                try {
                    await getAccount(this.connection, recipientATA);
                } catch {
                    transaction.add(createAssociatedTokenAccountInstruction(
                        this.keyPair.publicKey,
                        recipientATA,
                        recipient,
                        mint
                    ));
                }

                transaction.add(createTransferInstruction(
                    senderATA,
                    recipientATA,
                    this.keyPair.publicKey,
                    lamports
                ));
            } else {
                transaction.add(SystemProgram.transfer({
                    fromPubkey: this.keyPair.publicKey,
                    toPubkey: recipient,
                    lamports: lamports,
                }));
            }

            const signature = await this.sendAndConfirmTransaction(transaction);
            return signature;
        } catch (error) {
            logger.error(`${this.keyPair.publicKey.toBase58()} | ${error.stack}`);
            throw error;
        }
    }
}

module.exports = Wallet;