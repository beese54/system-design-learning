// Shared domain for every lab: a tiny music catalogue called "Riff".
// One dataset, three API styles on top of it. That is the whole point of
// the labs: the DATA never changes, only the CONTRACT you expose it with.

export const artists = [
  { id: 'a1', name: 'Nova Kim',        country: 'KR', formed: 2016, bio: 'Synth-pop producer working out of Seoul. Known for building songs live from field recordings.' },
  { id: 'a2', name: 'The Long Way',    country: 'IE', formed: 2009, bio: 'Four-piece from Cork. Two guitars, one organ, an unreasonable amount of reverb.' },
  { id: 'a3', name: 'Ama Boateng',     country: 'GH', formed: 2019, bio: 'Highlife-jazz bandleader and trumpet player based in Accra.' }
];

export const albums = [
  { id: 'b1', artistId: 'a1', title: 'Signal Hill',      year: 2021, artwork: '#6C5CE7' },
  { id: 'b2', artistId: 'a1', title: 'Static Garden',    year: 2024, artwork: '#00B894' },
  { id: 'b3', artistId: 'a2', title: 'Harbour Lights',   year: 2014, artwork: '#0984E3' },
  { id: 'b4', artistId: 'a2', title: 'Slow Weather',     year: 2019, artwork: '#D63031' },
  { id: 'b5', artistId: 'a3', title: 'Accra Nights',     year: 2022, artwork: '#E17055' }
];

export const tracks = [
  { id: 't1',  albumId: 'b1', title: 'Signal Hill',        seconds: 214, plays: 1_204_331 },
  { id: 't2',  albumId: 'b1', title: 'Paper Radio',        seconds: 187, plays:   842_010 },
  { id: 't3',  albumId: 'b1', title: 'Low Orbit',          seconds: 302, plays:   331_887 },
  { id: 't4',  albumId: 'b2', title: 'Static Garden',      seconds: 245, plays:   612_774 },
  { id: 't5',  albumId: 'b2', title: 'Tin Roof',           seconds: 198, plays:   129_004 },
  { id: 't6',  albumId: 'b3', title: 'Harbour Lights',     seconds: 271, plays: 2_004_559 },
  { id: 't7',  albumId: 'b3', title: 'Ferry at Six',       seconds: 233, plays:   744_102 },
  { id: 't8',  albumId: 'b4', title: 'Slow Weather',       seconds: 319, plays:   401_338 },
  { id: 't9',  albumId: 'b4', title: 'Coast Road',         seconds: 256, plays:   288_915 },
  { id: 't10', albumId: 'b5', title: 'Accra Nights',       seconds: 288, plays:   955_720 },
  { id: 't11', albumId: 'b5', title: 'Market Day Horns',   seconds: 224, plays:   410_663 }
];

// --- tiny query helpers (a stand-in for "the database layer") -------------
export const findArtist      = (id) => artists.find(a => a.id === id) || null;
export const findAlbum       = (id) => albums.find(b => b.id === id) || null;
export const findTrack       = (id) => tracks.find(t => t.id === id) || null;
export const albumsOfArtist  = (artistId) => albums.filter(b => b.artistId === artistId);
export const tracksOfAlbum   = (albumId) => tracks.filter(t => t.albumId === albumId);

// Every lab routes reads through here so the UI can show you how many
// "database queries" an API style actually costs. This is the number that
// makes N+1 visible instead of theoretical.
export const counters = { reads: 0 };
export const countRead = (n = 1) => { counters.reads += n; };
export const resetReads = () => { counters.reads = 0; };

// A fake "now playing" firehose, used by the gRPC streaming lab.
export function* playEvents(limit = 8) {
  const pool = tracks.map(t => ({ ...t, artist: findArtist(findAlbum(t.albumId).artistId).name }));
  for (let i = 0; i < limit; i++) {
    const t = pool[Math.floor(Math.random() * pool.length)];
    yield {
      trackId: t.id,
      title: t.title,
      artist: t.artist,
      city: ['Seoul', 'Cork', 'Accra', 'Lisbon', 'Toronto'][Math.floor(Math.random() * 5)],
      at: new Date().toISOString()
    };
  }
}
