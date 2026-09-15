declare module "@mathieuc/tradingview" {
  interface TradingViewSearchResult {
    id: string;
    exchange: string;
    fullExchange: string;
    symbol: string;
    description: string;
    type: string;
    getTA?: () => Promise<unknown>;
  }

  interface TradingViewModule {
    Client: new (options?: object) => any;
    searchMarketV3(
      search: string,
      filter?: "stock" | "futures" | "forex" | "cfd" | "crypto" | "index" | "economic" | "",
      offset?: number
    ): Promise<TradingViewSearchResult[]>;
  }

  const TradingView: TradingViewModule;
  export default TradingView;
}
