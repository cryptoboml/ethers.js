"use strict";

import WebSocket from "ws";

import { BigNumber } from "@ethersproject/bignumber";
import { Networkish } from "@ethersproject/networks";
import { defineReadOnly } from "@ethersproject/properties";

import { Event } from "./base-provider";
import { JsonRpcProvider } from "./json-rpc-provider";

import { Logger } from "@ethersproject/logger";
import { version } from "./_version";
const logger = new Logger(version);

/**
 *  Notes:
 *
 *  This provider differs a bit from the polling providers. One main
 *  difference is how it handles consistency. The polling providers
 *  will stall responses to ensure a consistent state, while this
 *  WebSocket provider assumes the connected backend will manage this.
 *
 *  For example, if a polling provider emits an event which indicats
 *  the event occurred in blockhash XXX, a call to fetch that block by
 *  its hash XXX, if not present will retry until it is present. This
 *  can occur when querying a pool of nodes that are mildly out of sync
 *  with each other.
 */

let NextId = 1;

export type InflightRequest = {
     callback: (error: Error, result: any) => void;
     payload: string;
};

export type Subscription = {
    tag: string;
    processFunc: (payload: any) => void;
};


// For more info about the Real-time Event API see:
//   https://geth.ethereum.org/docs/rpc/pubsub

export class WebSocketProvider extends JsonRpcProvider {
    readonly _websocket: any;
    readonly _requests: { [ name: string ]: InflightRequest };

    // Maps event tag to subscription ID (we dedupe identical events)
    readonly _subIds: { [ tag: string ]: Promise<string> };

    // Maps Subscription ID to Subscription
    readonly _subs: { [ name: string ]: Subscription };

    _wsReady: boolean;

    constructor(url: string, network: Networkish) {
        super(url, network);
        this._pollingInterval = -1;

        defineReadOnly(this, "_websocket", new WebSocket(this.connection.url));
        defineReadOnly(this, "_requests", { });
        defineReadOnly(this, "_subs", { });
        defineReadOnly(this, "_subIds", { });

        // Stall sending requests until the socket is open...
        this._wsReady = false;
        this._websocket.onopen = () => {
            this._wsReady = true;
            Object.keys(this._requests).forEach((id) => {
                this._websocket.send(this._requests[id].payload);
            });
        };

        this._websocket.onmessage = (messageEvent: { data: string }) => {
            const data = messageEvent.data;
            const result = JSON.parse(data);
            if (result.id != null) {
                const id = String(result.id);
                const request = this._requests[id];
                delete this._requests[id];

                if (result.result !== undefined) {
                    request.callback(null, result.result);

                } else {
                    if (result.error) {
                        const error: any = new Error(result.error.message || "unknown error");
                        defineReadOnly(error, "code", result.error.code || null);
                        defineReadOnly(error, "response", data);
                        request.callback(error, undefined);
                    } else {
                        request.callback(new Error("unknown error"), undefined);
                    }
                }

            } else if (result.method === "eth_subscription") {
                // Subscription...
                const sub = this._subs[result.params.subscription];
                if (sub) {
                    //this.emit.apply(this,                  );
                    sub.processFunc(result.params.result)
                }

            } else {
                console.warn("this should not happen");
            }
        };
    }

    get pollingInterval(): number {
        return 0;
    }

    resetEventsBlock(blockNumber: number): void {
        logger.throwError("cannot reset events block on WebSocketProvider", Logger.errors.UNSUPPORTED_OPERATION, {
            operation: "resetEventBlock"
        });
    }

    set pollingInterval(value: number) {
        logger.throwError("cannot set polling interval on WebSocketProvider", Logger.errors.UNSUPPORTED_OPERATION, {
            operation: "setPollingInterval"
        });
    }

    async poll(): Promise<void> {
        return null;
    }

    set polling(value: boolean) {
        if (!value) { return; }

        logger.throwError("cannot set polling on WebSocketProvider", Logger.errors.UNSUPPORTED_OPERATION, {
            operation: "setPolling"
        });
    }

    send(method: string, params?: Array<any>): Promise<any> {
        const rid = NextId++;

        return new Promise((resolve, reject) => {
            function callback(error: Error, result: any) {
                if (error) { return reject(error); }
                return resolve(result);
            }

            const payload = JSON.stringify({
                method: method,
                params: params,
                id: rid,
                jsonrpc: "2.0"
            });

            this._requests[String(rid)] = { callback, payload };

            if (this._wsReady) { this._websocket.send(payload); }
        });
    }

    static defaultUrl(): string {
        return "ws:/\/localhost:8546";
    }

    async _subscribe(tag: string, param: Array<any>, processFunc: (result: any) => void): Promise<void> {
        let subIdPromise = this._subIds[tag];
        if (subIdPromise == null) {
            subIdPromise = Promise.all(param).then((param) => {
                return this.send("eth_subscribe", param);
            });
            this._subIds[tag] = subIdPromise;
        }
        const subId = await subIdPromise;
        this._subs[subId] = { tag, processFunc };
    }

    _startEvent(event: Event): void {
        switch (event.type) {
            case "block":
                this._subscribe("block", [ "newHeads" ], (result: any) => {
                    this.emit("block", BigNumber.from(result.number).toNumber());
                });
                break;

            case "pending":
                this._subscribe("pending", [ "newPendingTransactions" ], (result: any) => {
                    this.emit("pending", result);
                });
                break;

            case "filter":
                this._subscribe(event.tag, [ "logs", this._getFilter(event.filter) ], (result: any) => {
                    if (result.removed == null) { result.removed = false; }
                    this.emit(event.filter, this.formatter.filterLog(result));
                });
                break;

            case "tx": {
                const emitReceipt = (event: Event) => {
                    const hash = event.hash;
                    this.getTransactionReceipt(hash).then((receipt) => {
                        if (!receipt) { return; }
                        this.emit(hash, receipt);
                    });
                };

                // In case it is already mined
                emitReceipt(event);

                // To keep things simple, we start up a single newHeads subscription
                // to keep an eye out for transactions we are watching for.
                // Starting a subscription for an event (i.e. "tx") that is already
                // running is (basically) a nop.
                this._subscribe("tx", [ "newHeads" ], (result: any) => {
                    this._events.filter((e) => (e.type === "tx")).forEach(emitReceipt);
                });
                break;
            }

            // Nothing is needed
            case "debug":
            case "error":
                break;

            default:
                console.log("unhandled:", event);
                break;
        }
    }

    _stopEvent(event: Event): void {
        let tag = event.tag;

        if (event.type === "tx") {
            // There are remaining transaction event listeners
            if (this._events.filter((e) => (e.type === "tx")).length) {
                return;
            }
            tag = "tx";
        } else if (this.listenerCount(event.event)) {
            // There are remaining event listeners
            return;
        }

        const subId = this._subIds[tag];
        if (!subId) { return; }

       delete this._subIds[tag];
       subId.then((subId) => {
            if (!this._subs[subId]) { return; }
            delete this._subs[subId];
            this.send("eth_unsubscribe", [ subId ]);
        });
    }
}
