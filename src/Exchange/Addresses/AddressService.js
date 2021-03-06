import Service from '../../common/Service';
import WSWrapper from '../../common/websockets/WSWrapper';

import Account from '../Accounts/Account';
import Balance, { BalanceInfo } from './Balance';
import Order from '../Orders/Order';
import Position from '../Orders/Position';

export default class AddressService extends Service {

  static routes = {
    portfolio: {
      get: '/v1/addresses/:address/portfolio'
    },
    info: { 
      get: '/v1/addresses/:address/info'
    },
    orders: {
      get: '/v1/orders/addresses/:address'
    },
    marginInfo: {
      get: '/v1/addresses/:address/margin-info'
    },
    openPositions: {
      get: '/v1/margin-positions/addresses/:address/open'
    },
    closedPositions: {
      get: '/v1/margin-positions/addresses/:address/closed'
    }
  };

  static exports = {
    Balance
  };

  /////////////////////////

  async watch(ownerAddress, brokerAddress) {
    if (this.watched && this.watched.ownerAddress !== ownerAddress) {
      await Promise.all([
        this.send('/v1/addresses/-address-/info', 'unsubscribe', { address: this.watched.ownerAddress }),
        this.send('/v1/orders/addresses/-address-', 'unsubscribe', { address: this.watched.ownerAddress }),
        this.send('/v1/orders/addresses/-address-/fills', 'unsubscribe', { address: this.watched.ownerAddress }),
        this.send('/v1/margin-positions/addresses/-address-', 'unsubscribe', { address: this.watched.ownerAddress }),
        this.send('/v1/addresses/-address-/portfolio', 'unsubscribe', { 
          address: this.watched.ownerAddress,
          broker_address: this.watched.brokerAddress 
        })
      ]);
    }

    this.watched = { ownerAddress, brokerAddress };

    if (!ownerAddress) return new Promise((resolve) => resolve());
    
    return Promise.all([
      this.send('/v1/addresses/-address-/info', 'subscribe', { address: ownerAddress }),
      this.send('/v1/orders/addresses/-address-', 'subscribe', { address: ownerAddress }),
      this.send('/v1/orders/addresses/-address-/fills', 'subscribe', { address: ownerAddress }),
      this.send('/v1/margin-positions/addresses/-address-', 'subscribe', { address: ownerAddress }),
      this.send('/v1/addresses/-address-/portfolio', 'subscribe', { 
        address: ownerAddress,
        broker_address: brokerAddress 
      })
    ]);
  }

  // ----------------------------------------------
  // Portfolio

  getPortfolio(ownerAddress, brokerAddress) {
    return this.get('portfolio', { address: ownerAddress, broker_address: brokerAddress })
      .then(body => {
        this.portfolioGlobals = body.global_objects;
        return Balance.hydrate(body.data, body.global_objects)
      });
  }

  onPortfolioUpdate(callback) {
    this.on('/v1/addresses/-address-/portfolio', 'update')
      .then((data) => {
        const fetchPortfolio = () => {
          const { ownerAddress, brokerAddress } = this.watched || {};
          this.getPortfolio(ownerAddress, brokerAddress)
            .then(portfolio => callback(portfolio))
        };

        if (this.portfolioGlobals) {
          try {
            callback(Balance.hydrate(data, this.portfolioGlobals));
          } catch(e) {
            fetchPortfolio();
          }
        } else {
          fetchPortfolio();
        }
      });

    // TODO: remove this when portfolio ws is more stable
    if (!this.portfolioWS) this.portfolioWS = new WSWrapper(() => {
      if (!this.watched || !this.watched.ownerAddress) return null;
      return this.getPortfolio(this.watched.ownerAddress, this.watched.brokerAddress); 
    }, 15); // update balances every 15s

    this.portfolioWS.subscribe(callback);
  }

  // ----------------------------------------------
  // Account

  getMarginInfo(address) {
    return this.get('marginInfo', { address }).then(body => body.data);
  }

  async getAccount(address) {
    const marginInfo = await this.getMarginInfo(address)
    const accountInfo = await this.get('info', { address }).then(body => body.data);
    return new Account({ ...accountInfo, margin_details: marginInfo });
  }

  onAccountUpdate(callback) {
    if (!this.accountWS) this.accountWS = new WSWrapper(() => {
      if (!this.watched || !this.watched.ownerAddress) return null;
      return this.getAccount(this.watched.ownerAddress).then((acc) => {
        if (acc.isMarginTradingEnabled) this.accountWS.kill();
        return acc;
      }); 
    }, 15); // update account every 15s

    this.accountWS.subscribe(callback);

    return this.on('/v1/addresses/-address-/info', 'update')
      .then(() => {
        if (this.watched && this.watched.ownerAddress) {
          return this.getAccount(this.watched.ownerAddress).then((acc) => callback(acc));
        }
      })
  }

  // ----------------------------------------------
  // Orders

  getOrders(address, options = {}) {
    return this.get('orders', { address, ...options })
      .then(body => Order.hydrate(body.data, body.global_objects));
  }

  onOrdersUpdate(callback) {
    this.on('/v1/orders/addresses/-address-', 'update')
      .build(data => Order.build(data))
      .then(callback);
  }

  onOrdersFillingUpdate(callback) {
    this.on('/v1/orders/addresses/-address-/fills', 'update')
      .build(data => Order.build(data))
      .then(callback);
  }

  // ----------------------------------------------
  // Positions

  async getPositions(address) {
    const open = await this.get('openPositions', { address })
      .then(body => Position.hydrate(body.data, body.global_objects));
    const closed = await this.get('closedPositions', { address })
      .then(body => Position.hydrate(body.data, body.global_objects));
    return [...open, ...closed];
  }

  onPositionsUpdate(callback) {
    this.on('/v1/margin-positions/addresses/-address-', 'update')
      .build(data => Position.build(data))
      .then(callback);
  }
}
