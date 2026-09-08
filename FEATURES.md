# Features
Diese Datei enthält Features die umgesetzt werden sollen. Wenn diese eingebaut sind, einen Haken zuvor machen.

1. [x] Single mode: eine Session in der noch keine andere Person geswipt hat, ist im Single mode. Es werden alle selbst geliketen Filme als match angezeigt. Erst wenn eine zweite Person im Raum Swipt, werden nur die gemeinsamen Matches angezeigt. Ein Punkt wo ich mir nicht sicher bin ob dieser bereits umgesetzt ist, es können auch mehr als 2 Personen Swipen und es werden die matches zwischen allen personen angezeigt.
2. [x] Zweite export option um immer lediglich seine eigenen likes zu exportieren und nicht die matches zwischen allen.
3. [x] Beim tippen auf ein Movie Cover wird dieses umgedreht und es erscheint eine kurzbeschreibung von einer Film/Serien Bewertungs DB. z.B. IMDB oder MovieDB/SerienDB oder rotten Tomato und zusätzlich eine Bewertung. Sollte das nicht so einfach möglich sein diese Informationen zu parsen und anzuzeigen, kann sich auch die Webseite der Platform in einem neuen Tab öffnen, wenn man auf den Titel des Films drückt.
4. [x] Login Funktion in Jellyfin statt username möglich - dadurch werden weitere funktionen freigeschaltet.
4.1 Wenn eine Person eingeloggt ist, kann beim erstellen einer session ein haken gesetzt werden, dass die matches zusätzlich als Playlist in Jellyfin erstellt werden. Name: Usernamen der Personen die swipen und der session code. Wenn mehrere personen in der session den login nutzen, wird bei beiden diese playlist erstellt.
