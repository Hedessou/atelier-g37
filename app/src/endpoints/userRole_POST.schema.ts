import {z} from "zod";import superjson from "superjson";
export const schema=z.object({id:z.number().int().positive(),role:z.enum(["admin","user"])});export type OutputType={success:true};
export const updateUserRole=async(body:z.infer<typeof schema>,init?:RequestInit):Promise<OutputType>=>{const r=await fetch("/_api/userRole",{method:"POST",body:superjson.stringify(schema.parse(body)),...init,headers:{"Content-Type":"application/json",...(init?.headers??{})},credentials:"include"});if(!r.ok)throw new Error(superjson.parse<{message:string}>(await r.text()).message||"Erreur");return superjson.parse<OutputType>(await r.text())};

