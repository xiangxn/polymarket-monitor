import { EventEmitter } from 'events';
export const eventBus = new EventEmitter();

export const EVENT_KEY_POLYMARKET_PRICE = 'polymarket:price:update'
export const EVENT_KEY_UPDATE_PRICE = 'price:update'
// export const EVENT_KEY_POLYMARKET_ORDERBOOK = 'polymarket:orderbook:update'
export const EVENT_KEY_MARKET_CREATE = 'polymarket:market:create'
export const EVENT_KEY_MARKET_START = 'polymarket:market:start'
export const EVENT_KEY_MARKET_RESOLVED = 'polymarket:market:resolved'
