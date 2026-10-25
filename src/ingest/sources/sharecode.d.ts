// globaloffensive-sharecode ships no types; only what valve.ts uses.
declare module "globaloffensive-sharecode" {
  export class ShareCode {
    constructor(code: string);
    decode(): { matchId: string; outcomeId: string; token: string };
  }
}
