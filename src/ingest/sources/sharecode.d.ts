// globaloffensive-sharecode ships no types; only what valve-gc.ts uses.
declare module "globaloffensive-sharecode" {
  export class ShareCode {
    constructor(code: string);
    decode(): { matchId: string; outcomeId: string; token: string };
  }
}
