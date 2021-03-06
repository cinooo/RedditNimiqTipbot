import fetch from 'node-fetch';
import btoa from 'btoa';
import Snoowrap from 'snoowrap';
import Snoostorm from 'snoostorm';

import nimiqHelper from './nimiqHelper.js';
import * as dynamo from './utils/dynamo.js';

const {
  VERSION,
  TIPBOT_USER_NAME,
  CLIENT_ID,
  CLIENT_SECRET,
  CLIENT_CODE,
  DONATE_ADDRESS,
  MESSAGES_POLL_TIME,
  NIMIQ_NETWORK,
  REDDIT_REFRESH_TOKEN,
  REDDIT_SUBSCRIBED_SUBREDDIT
} = process.env;

const REDDIT = {
  TOPICS: {
    DEPOSIT: 'Deposit',
    WITHDRAW: 'Withdraw',
    BALANCE: 'Balance',
    DONATE: 'Donate'
  }
};

const messageFooter = `
[${REDDIT.TOPICS.DEPOSIT}](https://np.reddit.com/message/compose/?to=${TIPBOT_USER_NAME}&subject=${REDDIT.TOPICS.DEPOSIT}&message=${encodeURIComponent('Deposit Nimiq!')}) | [${REDDIT.TOPICS.WITHDRAW}](https://np.reddit.com/message/compose/?to=${TIPBOT_USER_NAME}&subject=${REDDIT.TOPICS.WITHDRAW}&message=${encodeURIComponent('I want to withdraw my NIM!\namount NIM\naddress here')}) | [${REDDIT.TOPICS.BALANCE}](https://np.reddit.com/message/compose/?to=${TIPBOT_USER_NAME}&subject=${REDDIT.TOPICS.BALANCE}&message=${encodeURIComponent('I want to check my balance!')}) | [Help](https://www.reddit.com/r/NimiqTipbot/comments/8mpksa/nimiqtipbot_howto_and_faq/) |
[${REDDIT.TOPICS.DONATE}](${getNimDepositLink(DONATE_ADDRESS)}) |
[What is Nimiq?](https://www.nimiq.com)`;

const getTokenUrl = `https://${CLIENT_ID}:${CLIENT_SECRET}@www.reddit.com/api/v1/access_token`;
const postData = `grant_type=authorization_code&code=${CLIENT_CODE}&redirect_uri=http://www.example.com/unused/redirect/uri`;
const refreshTokenUrl = `https://www.reddit.com/api/v1/access_token`;

// format: NQXX XXXX XXXX ...
function getNimDepositLink(address) {
  const safeUrl = NIMIQ_NETWORK === 'main' ? 'https://safe.nimiq.com/' : 'https://safe.nimiq-testnet.com/';
  return `${safeUrl}#_request/${address.replace(/ /g, '-')}_`;
};

const getFirstToken = async () => {
  const response = await fetch(getTokenUrl, {
    method: 'POST',
    body: postData
  });
  const json = await response.json();
  console.log(json);
  return json;
};

const refreshToken = async token => {
  const options = {
    method: 'POST',
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(token)}`,
    headers: {
      'Authorization': 'Basic ' + btoa(unescape(encodeURIComponent(CLIENT_ID + ':' + CLIENT_SECRET))),
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  };
  console.log(options);
  const response = await fetch(refreshTokenUrl, options);
  const json = await response.json();
  console.log('new token', json);
  return json;
};

// reddit stuff
let r;
let client;
let messagesPollId; // setInterval id that polls messages
const streamOpts = {
  subreddit: REDDIT_SUBSCRIBED_SUBREDDIT,
  results: 5,
  pollTime: 5000
};

export default {
  R() {
    r = r || new Snoowrap({
      userAgent: `nodejs:au.com.lofico.nimiq:v${VERSION} (by /u/${TIPBOT_USER_NAME})`,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      refreshToken: REDDIT_REFRESH_TOKEN
    });
    return r;
  },

  Client() {
    client = client || new Snoostorm(this.R());
    return client;
  },

  async getCommentAuthorFromCommentName(commentName) {
    const response = await this.R().getComment(commentName).author.name;
    console.log(response);
    return response;
  },

  async logMessage(commentId, sourceAuthor, destinationAuthor, nimAmount) {

  },

  async markMessageAsRead(messageId) {
    console.log(`Marking ${messageId} as read`);
    await this.R().get_message(messageId).mark_as_read();
  },

  readMessages($) {
    messagesPollId = setInterval(async () => {
      const messages = await this.getPrivateMessages();
      if (messages.length > 0) {
        for (let i = 0; i < messages.length; i++) {
          const message = messages[i];
          await this.handleInboxMessage(message, $);
          // console.log('result', result);
          await this.markMessageAsRead(message.id);
        }
      };
    }, MESSAGES_POLL_TIME);
  },

  async getPrivateMessages() {
    const responses = await this.R().get_unread_messages({mark: false, limit: 2});
    // for (let i = 0; i < responses.length; i++) {
    //   console.log(responses[i])
    //   await this.markMessageAsRead(responses[i].id);
    // }

    // don't include auto inbox comment & post replies
    const actualMessages = responses.filter(response => response.was_comment === false);
    // console.log(actualMessages)
    return actualMessages.map(message => {
      const { author, subject, body, subreddit, id } = message;
      return {
        authorName: author.name, // the person mailing the tipbot
        subject, // the action
        subreddit, // good for logging source
        body, // content of the message
        id
      };
    });
  },

  async getReplyMessageForDeposit(authorName, $) {
    const { balance: userBalance, publicAddress: userAddress } = await dynamo.getUserPublicAddress(authorName, $);
    const replyMessage = `Your NIM address is: ${userAddress}

Your current balance is ${userBalance}

You can deposit by visiting ${getNimDepositLink(userAddress)}

Once you have deposited NIM to this address, you will be able to tip NIM to other redditors by replying to a comment or thread with +X.XXX NIM.
e.g. +30.2 NIM

Disclaimer: Please only deposit NIM that you are willing to lose to this address as there are no guarantees to this free service
${messageFooter}`;
    console.log(replyMessage);
    return {
      replyMessage,
      replySubject: 'Re: Deposit'
    };
  },

  async getReplyMessageForWithdraw(authorName, body, $) {
    // get the withdrawal amounts and address
    const replySubject = 'Re: Withdraw';
    const chunks = body.split('\n');

    if (chunks.length !== 3) {
      return {
        replyMessage: `Encountered a problem reading either the withdrawal amount or the NIM address, make sure you don't change the format of the reply message when submitting the withdrawal request (3 lines in the reply)`,
        replySubject
      };
    }
    const withdrawNimReg = /[0-9]+\.?[0-9]{0,6}/;
    const withdrawAmount = chunks[1].match(withdrawNimReg) ? chunks[1].match(withdrawNimReg)[0] : null;
    if (withdrawAmount === null) {
      return {
        replyMessage: `Encountered a problem reading the withdrawal amount, make sure it is a valid NIM amount`,
        replySubject
      };
    }
    const withdrawDestinationReg = /NQ[A-Z0-9 ]*$/;
    const withdrawDestination = chunks[2].trim().match(withdrawDestinationReg) ? chunks[2].trim().match(withdrawDestinationReg)[0] : null;
    if (withdrawDestination === null || !nimiqHelper.isValidFriendlyNimAddress(withdrawDestination)) {
      return {
        replyMessage: `Encountered a problem reading the NIM withdrawal address`,
        replySubject
      };
    }

    const { balance: userBalance, publicAddress: userAddress, privateKey } = await dynamo.getUserPublicAddress(authorName, $);
    if (parseFloat(userBalance) < parseFloat(withdrawAmount)) {
      return {
        replyMessage: `The ${withdrawAmount} NIM you are trying to withdraw is more than the total amount available in your account (${userBalance} NIM))`,
        replySubject
      };
    }

    // otherwise message saying process the withdraw request!
    return {
      replyMessage: `Processing your withdrawal of ${withdrawAmount} NIM to ${withdrawDestination}`,
      replySubject,
      userAddress,
      withdrawDestination,
      withdrawAmount,
      privateKey
    };
  },

  async getReplyMessageForBalance(authorName, $) {
    const { balance: userBalance, publicAddress: userAddress } = await dynamo.getUserPublicAddress(authorName, $);
    const replyMessage = `Your NIM address is: ${userAddress}

Your current balance is ${userBalance}

You can deposit by visiting ${getNimDepositLink(userAddress)}

Disclaimer: Please only deposit NIM that you are willing to lose to this address as there are no guarantees to this free service
${messageFooter}`;
    console.log(replyMessage);
    return {
      replyMessage,
      replySubject: 'Re: Balance'
    };
  },

  async postMessage(authorName, subject, message) {
    console.log('Posting message to', authorName, subject);
    await this.R().compose_message({
      to: authorName,
      subject,
      text: message
    });
    // expect(await r.get_sent_messages()[0].body).to.equal(timestamp);
  },

  // when a message comes into NimiqTipbot inbox it should be handled depending on the topic
  async handleInboxMessage(message, $) {
    const { subject, authorName, body } = message;
    console.log('handleInboxMessage', message);
    const { replyMessage, replySubject, userAddress, withdrawDestination, withdrawAmount, privateKey } = subject === REDDIT.TOPICS.DEPOSIT ? await this.getReplyMessageForDeposit(authorName, $)
      : subject === REDDIT.TOPICS.WITHDRAW ? await this.getReplyMessageForWithdraw(authorName, body, $)
        : subject === REDDIT.TOPICS.BALANCE ? await this.getReplyMessageForBalance(authorName, $) : {};
    if (replyMessage && replySubject) {
      await this.postMessage(authorName, replySubject, replyMessage);
    }

    if (subject === REDDIT.TOPICS.WITHDRAW && typeof privateKey !== 'undefined' && typeof withdrawDestination !== 'undefined' && typeof withdrawAmount !== 'undefined') {
      console.log('Legit withdrawal', withdrawDestination, withdrawAmount);
      // console.log('$', $);
      // process withdrawal
      const result = await $.sendTransaction(privateKey, withdrawDestination, withdrawAmount);
      return result;
    }
  },

  async replyComment(commentId, body) {
    const comment = await this.R().get_comment(commentId);
    const replyBody = `${body}

${messageFooter}`
    const result = await comment.reply(replyBody);
    return result;
  },

  readComments($) {
    const comments = this.Client().CommentStream(streamOpts);

    // On comment, perform whatever logic you want to do
    comments.on('comment', async (comment) => {
      // console.log(comment);
      const {
        id: commentId,
        body, // contains the text content of the comment
        author: {
          name: authorName // contains the name of the author
        },
        link_id: linkId, // unique id for the comment
        parent_id: parentId, // unique id of parent comment, same as linkId if there is no parent (e.g root comment)
        link_author: linkAuthor, // originating post author
        link_permalink: linkPermalink
      } = comment;
      const isRootComment = linkId === parentId;

      // the person tipping
      const sourceAuthor = authorName;

      // get the user name of who is being tipped
      const destinationAuthor =
        isRootComment
          ? linkAuthor // if it's a root comment, get the OP link author
          : await this.getCommentAuthorFromCommentName(parentId); // if it is a reply to a comment, get the parent id
      const isNimTipReg = /\+([0-9]+\.?[0-9]{0,6}) NIM[ ]?/mg;
      const matches = isNimTipReg.exec(body);
      const isNimTip = matches !== null;
      const nimAmount = isNimTip ? matches[1] : 0;

      const parsedObj = {
        isRootComment,
        sourceAuthor,
        destinationAuthor,
        body,
        isNimTip,
        nimAmount
      };

      console.log(JSON.stringify(parsedObj, null, 2));

      if (isNimTip) {
        // check to comment id to see if its already paid
        const loggedComment = await dynamo.queryTip(commentId);
        const hasNotBeenLogged = loggedComment.Count === 0;
        if (hasNotBeenLogged) {
          // originating source
          // check if account balance of source is sufficient
          const { balance: userBalance, publicAddress: userAddress, privateKey } = await dynamo.getUserPublicAddress(authorName, $);
          const { publicAddress: destinationFriendlyAddress } = await dynamo.getUserPublicAddress(destinationAuthor, $);
          if (userBalance >= nimAmount) {
            // has money, can proceed with tip
            await $.sendTransaction(privateKey, destinationFriendlyAddress, nimAmount);
            // log that comment has been paid
            await dynamo.putTip(commentId, {
              sourceAuthor: authorName,
              sourceAddress: userAddress,
              sourceBalance: userBalance,
              destinationAuthor,
              destinationAddress: destinationFriendlyAddress,
              nimAmount,
              linkPermalink
            });
            // console.log(result);
            await this.replyComment(commentId, `You have successfully tipped ${destinationAuthor} ${nimAmount} NIM.`);
          } else {
            // no amount? post a reply
            await this.replyComment(commentId, 'No NIM balance found for your account please use the links to make a NIM deposit first.');
          }
        }
      }
    });
  }
};
