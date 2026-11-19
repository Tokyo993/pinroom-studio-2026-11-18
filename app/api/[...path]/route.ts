import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../chatgpt-auth';
import {handleAccountApi} from '../../../server/account-api.mjs';

export const dynamic = 'force-dynamic';
async function handle(request: Request) {
  const user = await getChatGPTUser();
  return handleAccountApi(request, {user, db:env.DB, bucket:env.BUCKET});
}
export const GET=handle;
export const PUT=handle;
export const POST=handle;
export const DELETE=handle;
