import superjson from "superjson";
export type OutputType={users:Array<{id:number;email:string;displayName:string;role:"admin"|"user";createdAt:any}>};
export const getUsers=async(init?:RequestInit):Promise<OutputType>=>{const r=await fetch("/_api/users",{method:"GET",...init,headers:{"Content-Type":"application/json",...(init?.headers??{})},credentials:"include"});if(!r.ok)throw new Error(superjson.parse<{message:string}>(await r.text()).message||"Erreur");return superjson.parse<OutputType>(await r.text())};

