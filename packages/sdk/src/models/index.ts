import { ApiPromise } from "@polkadot/api";
import { ISubmittableResult } from "@polkadot/types/types";
import { hexToNumber, hexToString } from "@polkadot/util";
import all from "it-all";
import { concat, toString } from "uint8arrays";
import { unsubOrWarns } from "../util";

import {
  MarketEnd,
  MarketId,
  MarketResponse,
  ExtendedMarketResponse,
  PoolResponse,
  KeyringPairOrExtSigner,
  PoolId,
} from "../types";
import { initIpfs, changeEndianness, isExtSigner } from "../util";

import Market from "./market";
import Shares from "./shares";
import Swap from "./swaps";

export { Market, Shares, Swap };

export default class Models {
  public shares: Shares;

  private api: ApiPromise;

  constructor(api: ApiPromise) {
    this.api = api;
    this.shares = new Shares(this.api);
  }

  /**
   * Gets all the market ids that exist in storage.
   * Warning: This could take a while to finish.
   */
  async getAllMarketIds(): Promise<number[]> {
    const keys =
      this.api["config"] !== "mock"
        ? await this.api.query.predictionMarkets.markets.keys()
        : await this.api.query.predictionMarkets.marketIds.keys();

    return keys.map((key) => {
      const idStr = "0x" + changeEndianness(key.toString().slice(-32));
      const id = hexToNumber(idStr);
      return id;
    });
  }

  /**
   * Gets all markets that exist in storage.
   * Warning: this could take a while to finish.
   */
  async getAllMarkets(): Promise<Market[]> {
    const ids = await this.getAllMarketIds();

    return Promise.all(ids.map((id) => this.fetchMarketData(id)));
  }

  /**
   * Creates a new market with the given parameters. Returns the `marketId` that can be used
   * to get the full data via `sdk.models.fetchMarket(marketId)`.
   * @param signer The actual signer provider to sign the transaction.
   * @param title The title of the new prediction market.
   * @param description The description / extra information for the market.
   * @param oracle The address that will be responsible for reporting the market.
   * @param end Ending block or the ending unix timestamp of the market.
   * @param creationType "Permissionless" or "Advised"
   */
  async createNewMarket(
    signer: KeyringPairOrExtSigner,
    title: string,
    description: string,
    oracle: string,
    end: MarketEnd,
    creationType = "Advised",
    categories = ["Yes", "No"],
    callback?: (result: ISubmittableResult, _unsub: () => void) => void
  ): Promise<string> {
    const ipfs = initIpfs();

    const { cid } = await ipfs.add({
      content: JSON.stringify({
        title,
        description,
        categories,
      }),
    });

    return new Promise(async (resolve) => {
      const _callback = (
        result: ISubmittableResult,
        _resolve: (value: string | PromiseLike<string>) => void,
        _unsub: () => void
      ) => {
        const { events, status } = result;

        if (status.isInBlock) {
          console.log(`Transaction included at blockHash ${status.asInBlock}`);

          events.forEach(({ phase, event: { data, method, section } }) => {
            console.log(`\t' ${phase}: ${section}.${method}:: ${data}`);

            if (method == "MarketCreated") {
              _resolve(data[0].toString());
            } else if (method == "ExtrinsicFailed") {
              console.log("Extrinsic failed");
              _resolve("");
            }

            unsubOrWarns(_unsub);
          });
        }
      };

      if (isExtSigner(signer)) {
        const unsub = await this.api.tx.predictionMarkets
          .createCategoricalMarket(oracle, end, cid.toString(), creationType, categories.length)
          .signAndSend(signer.address, { signer: signer.signer }, (result) =>
            callback
              ? callback(result, unsub)
              : _callback(result, resolve, unsub)
          );
      } else {
        const unsub = await this.api.tx.predictionMarkets
          .createCategoricalMarket(oracle, end, cid.toString(), creationType, categories.length)
          .signAndSend(signer, (result) =>
            callback
              ? callback(result, unsub)
              : _callback(result, resolve, unsub)
          );
      }
    });
  }

  /**
   * Fetches data from Zeitgeist and IPFS for a market with a given identifier.
   * @param marketId The unique identifier for the market you want to fetch.
   */
  async fetchMarketData(marketId: MarketId): Promise<Market> {
    const ipfs = initIpfs();


    const marketRaw =
      await this.api.query.predictionMarkets.markets(marketId);

    const marketJson = marketRaw.toJSON();

    if (!marketJson) {
      throw new Error(`Market with market id ${marketId} does not exist.`);
    }

    //@ts-ignore
    const { metadata } = marketJson;
    const metadataString = hexToString(metadata.toString());

    // Default to no metadata, but actually parse it below if it exists.
    let data = {
      description: "No metadata",
      title: "No metadata",
      categories: ["No metadata"],
    };

    try {
      // Metadata exists, so parse it.
      if (metadataString) {
        const raw = toString(concat(await all(ipfs.cat(metadataString))));

        try {
          // new version
          const parsed = JSON.parse(raw) as {
            title: string;
            description: string;
            categories: string[];
          };
          data = parsed;
        } catch {
          const extract = (data: string) => {
            const titlePattern = "title:";
            const infoPattern = "::info:";
            return {
              description: data.slice(
                data.indexOf(infoPattern) + infoPattern.length
              ),
              title: data.slice(titlePattern.length, data.indexOf(infoPattern)),
              categories: ["Invalid", "Yes", "No"],
            };
          };

          data = extract(raw);
        }
      }
    } catch (err) { console.error(err); }


    //@ts-ignore
    const market = marketRaw.unwrap();

    //@ts-ignore
    const outcomeAssets = market.market_type.isCategorical 
      //@ts-ignore
      ? [...Array(market.market_type.asCategorical.toNumber()).keys()].map((catIdx) => {
          //@ts-ignore
          return this.api.createType("Asset", {
            categoricalOutcome: [ marketId, catIdx ]
          });
        })
      : ["Long", "Short"].map((pos) => {
        //@ts-ignore
        const position = this.api.createType("ScalarPosition", pos);
        //@ts-ignore
        return this.api.createType("Asset", {
          scalarOutcome: [ marketId, position.toString() ]
        });
      });

    const extendedMarket = marketJson;

    Object.assign(extendedMarket, {
      ...data,
      marketId,
      metadataString,
      outcomeAssets,
    });

    return new Market(extendedMarket as any, this.api);
  }

  async fetchPoolData(poolId: PoolId): Promise<Swap> {
    const poolResponse = (
      await this.api.query.swaps.pools(poolId)
    ).toJSON() as PoolResponse;

    return new Swap(poolId, poolResponse, this.api);
  }

  async getAssetsPrices(blockNumber: any): Promise<any> {
    const markets = await this.getAllMarkets();
    let priceData = {};
    for (const market of markets) {
      const assetPrices = await market.getAssetsPrices(blockNumber);
      priceData = { ...priceData, ...assetPrices };
    }
    return priceData;
  }
}
