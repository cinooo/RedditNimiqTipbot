import Nimiq from '@nimiq/core';

import MnemonicPhrase from './phrase.js';
let $ = {};

const {
  NIMIQ_NETWORK
} = process.env;

export default {
  async connect() {
    $.established = false;
    Nimiq.GenesisConfig[NIMIQ_NETWORK].call(this);

    console.log('Connecting to Nimiq network', NIMIQ_NETWORK);
    $.consensus = await Nimiq.Consensus.nano();

    $.blockchain = $.consensus.blockchain;
    $.mempool = $.consensus.mempool;
    $.network = $.consensus.network;

    $.consensus.on('established', () => this._onConsensusEstablished($));
    $.consensus.on('lost', () => {
      $.established = false;
      console.error('Consensus lost');
    });
    $.blockchain.on('head-changed', () => this._onHeadChanged($));
    $.network.on('peers-changed', () => this._onPeersChanged($));

    $.network.connect();

    $.isEstablished = this.isEstablished.bind(this);
    $.getBalance = this._getBalance.bind(this);

    return $;
  },

  _onConsensusEstablished() {
    console.log('Consensus established.');
    $.established = true;
    console.log('height:', $.blockchain.height);
    // console.log('Address:', $.wallet.address.toUserFriendlyAddress());

    // this._updateBalance();

    // Recheck balance on every head change.
    $.blockchain.on('head-changed', this._updateBalance.bind(this, $));
  },

  isEstablished() {
    return $.established;
  },

  async _updateBalance() {
    if ($.isEstablished()) {
      // const addresses = [$.wallet.address, 'NQ98 7PRX UB0T FURL F1B3 J07X H01P KD37 8FLD'];
      // this._getBalance($.wallet.address.toUserFriendlyAddress());
    }
  },

  _onBalanceChanged(account) {
    account = account || Nimiq.BasicAccount.INITIAL;
    const balance = Nimiq.Policy.satoshisToCoins(account.balance).toFixed(2);
    console.log(`New balance of ${$.wallet.address.toUserFriendlyAddress()} is ${balance}.`);
    console.log('balance:', balance);
  },

  _onHeadChanged() {
    const height = $.blockchain.height;
    console.log(`Now at height ${height}.`);
    // this._updateBalance($);
  },

  _onPeersChanged() {
    console.log(`Now connected to ${$.network.peerCount} peers.`);
    // document.getElementById('peers').innerText = $.network.peerCount;
  },

  async _getBalance(address, convertToCoins = true) {
    const walletAddress = this.getWalletFromUserFriendlyAddress(address);
    try {
      const account = await $.consensus.getAccount(walletAddress);
      const balance = account ? Nimiq.Policy.satoshisToCoins(account.balance).toFixed(2) : 0;
      console.log(`Address balance of ${address}: ${balance}`);
      return balance;
    } catch (e) {
      console.error('Failed _getBalance', e);
      return 0;
    }
  },

  async _getBalances(addresses) {
    await Promise.all(addresses.map(address => this._getBalance(address)));
  },

  async generateAddress() {
    const wallet = await Nimiq.Wallet.generate();
    const privateKey = wallet.keyPair.privateKey.toHex();
    const phrases = MnemonicPhrase.keyToMnemonic(privateKey);
    const publicAddress = wallet.address.toUserFriendlyAddress();
    console.log(privateKey);
    console.log(phrases);
    console.log(publicAddress);
    return {
      privateKey,
      phrases,
      publicAddress
    };
  },

  getWalletFromPrivateKey(privateKey) {
    const key = new Nimiq.PrivateKey(privateKey);
    const keyPair = Nimiq.KeyPair.derive(key);
    return new Nimiq.Wallet(keyPair);
  },

  getWalletFromPhrases(phrases) {
    const privateKey = Buffer.from(MnemonicPhrase.mnemonicToKey(phrases, 'hex'));
    return this.getWalletFromPrivateKey(privateKey);
  },

  // get a Nimiq wallet from a friendly address like 'NQ83 5CJY HF14 9N4N BLT6 QQ13 1NCJ 53LM YXNR'
  getWalletFromUserFriendlyAddress(address) {
    return Nimiq.Address.fromUserFriendlyAddress(address);
  },

  isValidFriendlyNimAddress(friendlyAddress) {
    return friendlyAddress.replace(/ /g, '').length === 36;
  },

  async sendTransaction(privateKey, destinationFriendlyAddress, coins) {
    const destinationAddress = Nimiq.Address.fromUserFriendlyAddress(destinationFriendlyAddress);
    const satoshis = Nimiq.Policy.coinsToSatoshis(coins);
    // get the wallet of the author
    const wallet = this.getWalletFromPrivateKey(privateKey);
    var transaction = wallet.createTransaction(
      destinationAddress, // who we are sending to
      satoshis, // amount in satoshi (no decimal format)
      140, // fee
      $.consensus.blockchain.head.height);
    const result = await $.consensus.relayTransaction(transaction);
    console.log('sendTransaction result', result);
    return result;
  }
};