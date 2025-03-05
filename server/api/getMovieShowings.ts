import {processData} from '../../shared/utils/app';

export default cachedEventHandler(async (event) => {
  const response : any = await $fetch('https://api.kino.dk/ticketflow/showtimes?format=json&region=content&city=24-41-70-55&sort=alphabetical');

  return processData(response);
  }, {
  maxAge: 60 * 60,
  getKey: () => 'movieShowings',
  }
)