const readline = require('readline');
const { PublicKey } = require('@solana/web3.js');
const fs = require('fs');
const log = require('../utils/logger');

async function getHolders() {    
    const { gotScraping } = await import('got-scraping');
 
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    const collectionAddress = await new Promise(resolve => {
        rl.question('Enter Solana NFT collection address: ', (address) => {
            rl.close();
            resolve(address);
        });
    });

    try {
        new PublicKey(collectionAddress);
    } catch (e) {
        log.error('❌ Invalid collection address');
        process.exit(1);
    }

    log.info(`🔍 Getting data about the collection: ${collectionAddress}...`);

    const COLLECTION_ADDRESS = collectionAddress;
    
    const holders = {};
    let offset = 0;
    let totalNfts = 0;
    let hasMore = true;
    
    while (hasMore) {
        try {
            const params = new URLSearchParams({
                onChainCollectionAddress: COLLECTION_ADDRESS,
                offset: offset,
                limit: 150,
                direction: 2,
                token22StandardFilter: 1,
                mplCoreStandardFilter: 1,
                agg: 3,
                compressionMode: 'both'
            });
            
            const url = `https://api-mainnet.magiceden.io/idxv2/getAllNftsByCollectionSymbol?${params.toString()}`;            
            const headers = {
                'accept': 'application/json',
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/134.0.0.0 Safari/537.36',
                'Referer': 'https://magiceden.io/'
            };
            
            const response = await gotScraping({
                url: url,
                headers: headers,
                responseType: 'json',
                timeout: { request: 30000 }
            });

            const nfts = response.body.results || [];
            
            if (nfts.length === 0) {
                hasMore = false;
                continue;
            }
            
            for (const nft of nfts) 
                if (nft.owner) {
                    holders[nft.owner] = (holders[nft.owner] || 0) + 1;
                    totalNfts++;
                }
            
            offset += nfts.length;
            if (nfts.length < 150) hasMore = false;
            
            // // Делаем паузу между запросами
            // await new Promise(resolve => setTimeout(resolve, 1500));
            
        } catch (error) {
            log.error(error.stack);
            
            // // Пауза при ошибке
            // await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
    
    log.info(`Processed ${totalNfts} NFTs from the collection`);
    
    const sortedHolders = Object.entries(holders)
        .sort((a, b) => b[1] - a[1])
        .reduce((acc, [key, value]) => {
            acc[key] = value;
            return acc;
        }, {});
    
    log.info(`🎯 Total unique holders: ${Object.keys(sortedHolders).length}`);
    
    fs.writeFileSync('holders.json', JSON.stringify(sortedHolders, null, 2));
    log.info('Results saved to holders.json');
}

getHolders().catch(console.error);  