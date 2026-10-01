"""
Vendored from kratos trunk `visual/binary_io.py` (kratos repo,
~/Seafile/seafile_sync/code/kratos, copied 2026-10-01).

DO NOT EDIT HERE — the kratos repo is the source of truth for the .bin
format. If the format changes, re-copy this file and re-run
tests/test_binread.py against tests/fixtures/sod_univ_00000.bin.

Only dependency: numpy.
"""

from numpy import array, frombuffer, ndarray

############################################################
# Basic binary output reader

class binary_io:
    ########################################################
    # Initialization and finalization
    def __init__( self,    file_name, cache_used = True ):
        self. file_name =  file_name;
        self.      dmap =  dict(   );
        self.      hmap =  dict(   );
        self.cache_used = cache_used;
        self.    endian =   'little';
        self.    offset =          0;
        self.    stream =       None;
    #
    def set_stream( self, stream ):
        self.stream     = stream  ;
    #
    def get_size_t( self, bin_data = None ):
        if  bin_data is None:
            bin_data =  self.stream.read( self.s_size_t );
        return int.from_bytes ( bin_data, self.  endian );
    #
    def get_char_t( self, bin_data = None ):
        if  bin_data is None:
            bin_data =  self.stream.read            ( 1 );
        return int.from_bytes ( bin_data, self.  endian );
    #
    def close( self ):
        if  self.stream is not None:
            self.stream.close(  );
            self.stream =    None;
        return;
    #
    def open_basic( self ):
        if  self.stream is None:
            self.stream = open( self.file_name, 'rb' );
            self.stream . seek( 0, 0 );
        #
        return;
    #
    def open( self, instant_close = False ):
        if self.stream is not None:
            return;
        #
        self.open_basic(  );
        # First byte stores: ( is_le | sizeof( size_t ) )
        # Note: one byte does not care about endian
        sst           = int.from_bytes\
                      ( self.stream.read( 1 ), 'little' );
        self.endian   = "little" if sst & 1  else "big";
        self.s_size_t = sst & ( ~ 1 );
        self.s_hdr    = self.get_size_t(  );
        self.s_hmap   = self.get_size_t(  );
        for i_hmap in range( self.s_hmap  ):
            s_kstr = self.get_size_t(  );
            key    = self.stream.read( s_kstr );
            size   = self.get_size_t(  );
            u_size = self.get_char_t(  );
            offset = self.get_size_t(  ) + self.s_hdr;
            self.hmap[ key.decode( 'ascii' ) ]\
                   = ( size, u_size,  offset );
        #
        if  instant_close:
            self.close(  );
        return;
    #

    def __enter__( self ):
        self.open(  );
        return self;
    #

    def __exit__ ( self, etype, evalue, traceback ):
        self.close(  );
        if etype is not None:
            print( etype, evalue, traceback );
        #
    #
    ########################################################
    # Data access
    def __getitem__  ( self,    key ):
        if  key in self.dmap:
            return self.dmap[ key ];
        #
        size, u_size, offset = self.hmap[ key ];
        self.stream.seek( offset, 0 );
        bin_data     = self.stream.read( size );
        if  self.cache_used:
            self.dmap[ key ] = bin_data;
        #
        return bin_data;
    #
    def read( self ):
        for key in self.hmap:
            size, u_size, offset = self.hmap   [  key ];
            self.stream.seek ( offset, 0 );
            self.dmap[ key ] = self.stream.read( size );
        #
    #
    def as_array( self, key, dtype  = 'f' ):
        u_size  = self.hmap[ key ][ 1 ];
        return  frombuffer( self[ key ], dtype = \
                            '<%s%d' %  ( dtype, u_size ) );
    #
