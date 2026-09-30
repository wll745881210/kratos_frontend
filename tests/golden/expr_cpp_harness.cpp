// Golden-vector harness for the C++ expression engine (source of truth).
// Reads TSV lines from stdin:  expr \t name0=val0 \t name1=val1 ...
// (variable map in index order; zero columns = empty map).
// Prints one line per input: the value with %.17g, or "ERROR: <msg>".
//
// Build (no CUDA needed):
//   g++ -std=c++17 -D__host__= -D__device__= \
//       -I <kratos>/usr_ext/universal expr_cpp_harness.cpp -o expr_cpp_harness

#include "expr.h"

#include <cstdio>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

int main( )
{
    std::string line;
    while( std::getline( std::cin, line ) )
    {
        if( line.empty( ) )
            continue;
        std::vector< std::string > cols;
        std::stringstream ss( line );
        std::string col;
        while( std::getline( ss, col, '\t' ) )
            cols.push_back( col );
        if( cols.empty( ) )
        {
            std::printf( "ERROR: bad harness input (empty line)\n" );
            continue;
        }
        // Remaining columns: name=value pairs (index order).
        std::map< std::string, int > vars;
        std::vector< double >      v;
        for( size_t i = 1; i < cols.size( ); ++ i )
        {
            const auto eq = cols[ i ].find( '=' );
            vars[ cols[ i ].substr( 0, eq ) ] = int( v.size( ) );
            v.push_back( std::stod( cols[ i ].substr( eq + 1 ) ) );
        }
        try
        {
            const auto prog = univ::expr::compile( cols[ 0 ], vars );
            const auto val  = univ::expr::eval( prog, v.data( ) );
            std::printf( "%.17g\n", double( val ) );
        }
        catch( const std::exception & e )
        {
            std::printf( "ERROR: %s\n", e.what(  ) );
        }
    }
    return 0;
}
