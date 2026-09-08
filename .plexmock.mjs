import http from 'node:http'
import url from 'node:url'

const PORT = 32400

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true)
  const pathname = parsedUrl.pathname
  const query = parsedUrl.query

  res.setHeader('Content-Type', 'application/json')

  // GET /library/sections
  if (pathname === '/library/sections') {
    res.writeHead(200)
    res.end(JSON.stringify({
      MediaContainer: {
        size: 1,
        totalSize: 1,
        allowSync: '1',
        identifier: 'com.plexapp.plugins.library',
        mediaTagPrefix: '/system/bundle/media/flags/',
        mediaTagVersion: 1606582928,
        title1: 'Plex Library',
        viewMode: 65592,
        Directory: [
          {
            allowSync: '1',
            art: '/:/resources/movie-fanart.jpg',
            composite: '/library/sections/1/composite/1609459471',
            filters: '1',
            refreshing: '0',
            thumb: '/:/resources/movie.png',
            key: '1',
            type: 'movie',
            title: 'Filme',
            agent: 'com.plexapp.agents.themoviedb',
            scanner: 'Plex Movie',
            language: 'de',
            uuid: '12345678-abcd-1234-abcd-123456789012',
            updatedAt: '1609459471',
            createdAt: '1609459471',
            scannedAt: '1609459471',
            content: '1',
            directory: '1',
            contentChangedAt: '1609459471',
            hidden: 0,
          },
        ],
      },
    }))
    return
  }

  // GET /library/sections/1/all
  if (pathname === '/library/sections/1/all') {
    res.writeHead(200)
    res.end(JSON.stringify({
      MediaContainer: {
        size: 4,
        totalSize: 4,
        allowSync: '1',
        identifier: 'com.plexapp.plugins.library',
        mediaTagPrefix: '/system/bundle/media/flags/',
        mediaTagVersion: 1606582928,
        librarySectionTitle: 'Filme',
        librarySectionID: 1,
        librarySectionUUID: '12345678-abcd-1234-abcd-123456789012',
        title1: 'Filme',
        title2: 'All Movies',
        viewGroup: 'movie',
        viewMode: 65592,
        thumb: '/library/sections/1/thumb/1609459471',
        art: '/library/sections/1/art/1609459471',
        Metadata: [
          // Film 1: vollständig mit rating als Zahl, year als Zahl
          {
            ratingKey: '1',
            key: '/library/metadata/1',
            guid: 'plex://movie/5d776b59399d3b001f79c6f1',
            studio: 'Universal Pictures',
            type: 'movie',
            title: 'The Matrix',
            contentRating: 'R',
            summary: 'A computer hacker learns from mysterious rebels about the true nature of his reality and his role in the war against its controllers.',
            rating: 7.9,
            viewCount: '5',
            lastViewedAt: '1609459471',
            year: 1999,
            tagline: 'Welcome to the Real World',
            thumb: '/library/metadata/1/thumb/1609459471',
            art: '/library/metadata/1/art/1609459471',
            duration: '8160000',
            originallyAvailableAt: '1999-03-31',
            addedAt: '1609459471',
            updatedAt: '1609459471',
            chapterSource: 'agent',
            primaryExtraKey: '',
            Media: [
              {
                id: '1',
                duration: '8160000',
                bitrate: '5000',
                width: '1920',
                height: '1080',
                aspectRatio: '1.78',
                audioChannels: '6',
                audioCodec: 'ac3',
                videoCodec: 'h264',
                videoResolution: '1080',
                container: 'mkv',
                videoFrameRate: '23.976',
                audioProfile: 'DTS',
                videoProfile: 'high',
                Part: [
                  {
                    id: 1,
                    key: '/library/parts/1/file.mkv',
                    duration: 8160000,
                    file: '/media/movies/The.Matrix.1999.1080p.mkv',
                    size: 4200000000,
                    audioProfile: 'DTS',
                    container: 'mkv',
                    indexes: 'sd',
                    videoProfile: 'high',
                  },
                ],
              },
            ],
            Director: [
              {
                tag: 'Lana Wachowski',
              },
              {
                tag: 'Lilly Wachowski',
              },
            ],
            Genre: [
              { tag: 'Action' },
              { tag: 'Sci-Fi' },
            ],
          },
          // Film 2: ohne rating
          {
            ratingKey: '2',
            key: '/library/metadata/2',
            guid: 'plex://movie/5d776b59399d3b001f79c6f2',
            studio: 'Warner Bros',
            type: 'movie',
            title: 'Inception',
            contentRating: 'PG-13',
            summary: 'A skilled thief who steals corporate secrets through dream-sharing technology is given the inverse task of planting an idea into the mind of a C.E.O.',
            // rating omitted
            viewCount: '3',
            lastViewedAt: '1609459472',
            year: 2010,
            tagline: 'Your Mind is the Scene of the Crime',
            thumb: '/library/metadata/2/thumb/1609459472',
            art: '/library/metadata/2/art/1609459472',
            duration: '8880000',
            originallyAvailableAt: '2010-07-16',
            addedAt: '1609459472',
            updatedAt: '1609459472',
            chapterSource: 'agent',
            primaryExtraKey: '',
            Media: [
              {
                id: '2',
                duration: '8880000',
                bitrate: '4500',
                width: '1920',
                height: '1080',
                aspectRatio: '1.78',
                audioChannels: '6',
                audioCodec: 'ac3',
                videoCodec: 'h264',
                videoResolution: '1080',
                container: 'mkv',
                videoFrameRate: '23.976',
                audioProfile: 'DTS',
                videoProfile: 'high',
                Part: [
                  {
                    id: 2,
                    key: '/library/parts/2/file.mkv',
                    duration: 8880000,
                    file: '/media/movies/Inception.2010.1080p.mkv',
                    size: 3900000000,
                    audioProfile: 'DTS',
                    container: 'mkv',
                    indexes: 'sd',
                    videoProfile: 'high',
                  },
                ],
              },
            ],
            Director: [
              {
                tag: 'Christopher Nolan',
              },
            ],
          },
          // Film 3: ohne summary und ohne year
          {
            ratingKey: '3',
            key: '/library/metadata/3',
            guid: 'plex://movie/5d776b59399d3b001f79c6f3',
            studio: 'Paramount',
            type: 'movie',
            title: 'Interstellar',
            contentRating: 'PG-13',
            // summary omitted
            rating: 8.6,
            viewCount: '2',
            lastViewedAt: '1609459473',
            // year omitted
            tagline: 'Mankind was born on Earth. It was never meant to die here.',
            thumb: '/library/metadata/3/thumb/1609459473',
            art: '/library/metadata/3/art/1609459473',
            duration: '10680000',
            originallyAvailableAt: '2014-11-07',
            addedAt: '1609459473',
            updatedAt: '1609459473',
            chapterSource: 'agent',
            primaryExtraKey: '',
            Media: [
              {
                id: '3',
                duration: '10680000',
                bitrate: '5500',
                width: '1920',
                height: '1080',
                aspectRatio: '1.78',
                audioChannels: '6',
                audioCodec: 'ac3',
                videoCodec: 'h264',
                videoResolution: '1080',
                container: 'mkv',
                videoFrameRate: '23.976',
                audioProfile: 'DTS',
                videoProfile: 'high',
                Part: [
                  {
                    id: 3,
                    key: '/library/parts/3/file.mkv',
                    duration: 10680000,
                    file: '/media/movies/Interstellar.2014.1080p.mkv',
                    size: 4700000000,
                    audioProfile: 'DTS',
                    container: 'mkv',
                    indexes: 'sd',
                    videoProfile: 'high',
                  },
                ],
              },
            ],
            Genre: [
              { tag: 'Adventure' },
              { tag: 'Drama' },
              { tag: 'Sci-Fi' },
            ],
          },
          // Film 4: ohne Director
          {
            ratingKey: '4',
            key: '/library/metadata/4',
            guid: 'plex://movie/5d776b59399d3b001f79c6f4',
            studio: 'Disney',
            type: 'movie',
            title: 'The Lion King',
            contentRating: 'G',
            summary: 'Lion prince Simba and his father are targeted by his bitter uncle, who wants to ascend the throne himself.',
            rating: 8.5,
            viewCount: '10',
            lastViewedAt: '1609459474',
            year: 1994,
            tagline: 'Life awaits',
            thumb: '/library/metadata/4/thumb/1609459474',
            art: '/library/metadata/4/art/1609459474',
            duration: '5280000',
            originallyAvailableAt: '1994-06-19',
            addedAt: '1609459474',
            updatedAt: '1609459474',
            chapterSource: 'agent',
            primaryExtraKey: '',
            Media: [
              {
                id: '4',
                duration: '5280000',
                bitrate: '3500',
                width: '1920',
                height: '1080',
                aspectRatio: '1.78',
                audioChannels: '6',
                audioCodec: 'ac3',
                videoCodec: 'h264',
                videoResolution: '1080',
                container: 'mkv',
                videoFrameRate: '23.976',
                audioProfile: 'DTS',
                videoProfile: 'high',
                Part: [
                  {
                    id: 4,
                    key: '/library/parts/4/file.mkv',
                    duration: 5280000,
                    file: '/media/movies/The.Lion.King.1994.1080p.mkv',
                    size: 2800000000,
                    audioProfile: 'DTS',
                    container: 'mkv',
                    indexes: 'sd',
                    videoProfile: 'high',
                  },
                ],
              },
            ],
            // Director omitted
            Genre: [
              { tag: 'Animation' },
              { tag: 'Drama' },
            ],
          },
        ],
      },
    }))
    return
  }

  // GET /media/providers
  if (pathname === '/media/providers') {
    res.writeHead(200)
    res.end(JSON.stringify({
      MediaContainer: {
        machineIdentifier: 'mockedplexserver123456',
      },
    }))
    return
  }

  // Default: return some bytes as JPEG
  res.setHeader('Content-Type', 'image/jpeg')
  res.writeHead(200)
  res.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))
})

server.listen(PORT, () => {
  console.log(`Mock Plex server listening on port ${PORT}`)
})
