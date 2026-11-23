.. _versioned-kvstore:

versioned: bucket with object versioning at a chosen time
=========================================================

The versioned :ref:`key-value store adapter<kvstore-adapters>` reads a bucket
that has object versioning enabled as it was at a chosen time. Every file is
read in the version that was live at that time, so any data source on top of
it (for example a precomputed image, segmentation or annotation layer) shows
its past state.

URL syntax
----------

- :file:`{base-kvstore-url/}|versioned:{path}`
- :file:`{base-kvstore-url/}|versioned:@{TIMESTAMP}/{path}`

The :file:`{base-kvstore-url/}` must be a directory in a ``gs://`` (or
``gs+ngauth+…``) bucket, or an ``s3://`` / ``s3+http(s)://`` bucket.

- Without a timestamp, current data is read, exactly as without the adapter
  (no extra requests).

- The timestamp is in `ISO 8601 <https://en.wikipedia.org/wiki/ISO_8601>`__ UTC
  syntax :file:`{YYYY}-{MM}-{DD}T{hh}:{mm}:{ss}Z`, optionally with fractional
  seconds.

For example:

- ``gs://bucket/path/to/layer/|versioned:|neuroglancer-precomputed:``
- ``gs://bucket/path/to/layer/|versioned:@2026-11-10T12:00:00Z/|neuroglancer-precomputed:``
- ``s3://bucket/path/to/layer/|versioned:@2026-11-10T12:00:00Z/|neuroglancer-precomputed:``

Time control
------------

Any precomputed layer (image, segmentation, annotation) in a ``gs://`` or
``s3://`` bucket shows a :guilabel:`Version history` block in its
:guilabel:`Source` tab, right under its URL, with a :guilabel:`Time` picker
and a list of the layer's saved versions (the same picker as the
Calcada/graphene time control):

- Picking a time sets the layer's own ``versionTime`` (saved in the layer
  state and share links, e.g. ``"versionTime": "2026-11-10T12:00:00Z"``).
  The data source URL does not change and the data source is not loaded
  again: the layer only requests its chunks again, read through the adapter
  at that time. The layer shows the bucket as it was then (read-only).
- Clearing the time returns the layer to current data; it can be edited
  again.

The time is per layer, also when several layers show the same data source.
Image and segmentation volumes, segmentation meshes and skeletons, and
annotations (by id, relationships and spatial index) are all read at the
layer's time; each time is cached separately, so versions are never mixed
and returning to a version already viewed reuses its cached chunks. The
layer's ``info`` files (scales, bounds, segment properties) are read once,
from the current data.

A URL that contains ``|versioned:`` itself (written by hand) works as well:
its timestamp applies to the whole data source, including its ``info``. A
relative path that leaves the layer directory (``../…``) needs
``|versioned:`` placed higher up, for example right after the bucket:
``gs://bucket/|versioned:@{TIMESTAMP}/path/to/layer/|neuroglancer-precomputed:``.

The bucket needs object versioning (see Permissions); on a bucket without it,
a past time finds no versions and the layer reports its files as missing.

A layer viewed at a past time, or read through ``|versioned:``, cannot take
part in an edit session (it can only be Off): saving writes to the bucket's
current objects, so editing past data would overwrite the live layer. To
edit, clear the time (and use a URL without ``|versioned:``).

How a file is resolved
----------------------

For each file, the adapter lists the stored versions of exactly that key once
(the list is cached, so choosing another time needs no new listing) and reads
the version that was live at the chosen time. A listing made shortly before or
after the chosen time is refreshed (at most every 10 seconds per file), so
writes close to that time are not missed. A file that did not exist at that
time (not yet written, or already deleted) reads as missing; the current version
is never used instead.

Permissions
-----------

Reading at a time needs, on the bucket:

- GCS: ``storage.objects.list`` and ``storage.objects.get``.
- S3: ``s3:ListBucketVersions`` and ``s3:GetObjectVersion``; the bucket's CORS
  configuration must allow ``GET`` and ``HEAD`` from the viewer's origin.

Caveats
-------

- History starts when versioning was enabled on the bucket; it is not
  retroactive.
- A time in the middle of a long write shows a mix of old and new files.
- Lifecycle rules that delete noncurrent versions make older times unavailable.
- Listing (URL completion) shows current file names.
- A layer viewed at a past time uses the current ``info`` files: if the
  layer's structure itself changed since (scales added, bounds changed), the
  past chunks are shown with the current structure.
- After switching versions, the layer is briefly empty where chunks of the
  new version are still loading.
- S3 records modification times with 1 second precision. A version counts as
  written at the end of its second, so data written after the chosen time is
  never shown, but the previous version may be shown for up to one second
  after a write.
- Each file needs one listing request the first time it is read at a time; for
  sharded layers this is one request per shard file.

Capabilities
------------

.. list-table:: Supported capabilities

   * - :ref:`kvstore-byte-range-reads`
     - Supported, if supported by the base key-value store.
   * - :ref:`kvstore-listing`
     - Current keys only.
