const { Keypair } = require('@solana/web3.js');
const fs = require('fs');
const bs58 = require('bs58');
const config = require('../../config/config');
const logger = require('./logger');

class Wallet {
  constructor() {
    this.keypair = null;
    this.initialize();
  }

  initialize() {
    try {
      // Try to load from private key first
      if (config.solana.walletPrivateKey) {
        this.loadFromPrivateKey(config.solana.walletPrivateKey);
        return;
      }

      // Then try to load from keypair file
      if (config.solana.walletKeypairPath) {
        this.loadFromKeypairFile(config.solana.walletKeypairPath);
        return;
      }

      throw new Error('No wallet configuration found');
    } catch (error) {
      logger.error(`Failed to initialize wallet: ${error.message}`);
      throw error;
    }
  }

  loadFromPrivateKey(privateKey) {
    try {
      const decodedKey = bs58.decode(privateKey);
      this.keypair = Keypair.fromSecretKey(decodedKey);
      logger.info(`Wallet loaded from private key: ${this.getPublicKey()}`);
    } catch (error) {
      logger.error(`Failed to load wallet from private key: ${error.message}`);
      throw error;
    }
  }

  loadFromKeypairFile(keypairPath) {
    try {
      const keypairData = fs.readFileSync(keypairPath, 'utf8');
      let secretKey;

      try {
        // Try parsing as JSON
        const parsedData = JSON.parse(keypairData);
        secretKey = Uint8Array.from(parsedData);
      } catch (e) {
        // If not JSON, try as base58 string
        secretKey = bs58.decode(keypairData.trim());
      }

      this.keypair = Keypair.fromSecretKey(secretKey);
      logger.info(`Wallet loaded from keypair file: ${this.getPublicKey()}`);
    } catch (error) {
      logger.error(`Failed to load wallet from keypair file: ${error.message}`);
      throw error;
    }
  }

  getKeypair() {
    if (!this.keypair) {
      throw new Error('Wallet not initialized');
    }
    return this.keypair;
  }

  getPublicKey() {
    if (!this.keypair) {
      throw new Error('Wallet not initialized');
    }
    return this.keypair.publicKey.toString();
  }
}

module.exports = new Wallet();